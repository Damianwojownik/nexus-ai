import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ToolConnector, ConnectorHealth } from './capabilityRegistry.ts';

export class OmniRouteLocalConnector implements ToolConnector {
  readonly id = 'omniroute-local';
  readonly name = 'OmniRoute local (no inference)';
  readonly authType = 'local' as const;
  readonly priority = 10;
  readonly capabilities = [{ id: 'routing.local_status', name: 'Local gateway status', readOnly: true }];
  private readonly fetcher: typeof fetch;

  constructor(fetcher: typeof fetch = fetch) { this.fetcher = fetcher; }

  async healthCheck(): Promise<ConnectorHealth> {
    try {
      const response = await this.fetcher('http://127.0.0.1:20128/api/health', {
        signal: AbortSignal.timeout(3000), redirect: 'error',
      });
      if (!response.ok) return { status: 'unavailable', message: `OmniRoute health HTTP ${response.status}` };
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || !('status' in value) || value.status !== 'ok') {
        return { status: 'error', message: 'Invalid OmniRoute health response' };
      }
      return { status: 'healthy', message: 'Local routing gateway connected; inference disabled to prevent provider charges.' };
    } catch (error) {
      return { status: 'unavailable', message: error instanceof Error ? error.message : 'OmniRoute offline' };
    }
  }

  async execute(capability: string): Promise<unknown> {
    if (capability !== 'routing.local_status') throw new Error('Unsupported OmniRoute capability');
    return this.healthCheck();
  }
}

interface CompressionResult {
  compressed: string;
  originalTokens: number;
  compressedTokens: number;
  originalVerified: true;
}

function headroomCommand(): string {
  return process.env.NEXUS_HEADROOM_COMMAND
    ?? (process.platform === 'win32' ? join(homedir(), '.local', 'bin', 'headroom.exe') : 'headroom');
}

export class HeadroomLocalConnector implements ToolConnector {
  readonly id = 'headroom-local';
  readonly name = 'Headroom local compression';
  readonly authType = 'local' as const;
  readonly priority = 10;
  readonly capabilities = [{ id: 'context.compress', name: 'Compress context copy and verify original', readOnly: true }];

  async healthCheck(): Promise<ConnectorHealth> {
    if (process.platform === 'win32' && !existsSync(headroomCommand())) {
      return { status: 'not_configured', message: 'Headroom executable not installed' };
    }
    return { status: 'healthy', message: 'Local stdio compression, no model API or source-file deletion.' };
  }

  async execute(capability: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CompressionResult> {
    if (capability !== 'context.compress') throw new Error('Unsupported Headroom capability');
    if (typeof args.content !== 'string' || !args.content.trim() || args.content.length > 200000) {
      throw new Error('content must contain 1-200000 characters');
    }
    const original = args.content;
    if (signal?.aborted) throw signal.reason;
    const child = spawn(headroomCommand(), ['mcp', 'serve'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    let id = 0;
    let failure: Error | undefined;
    const fail = (error: Error) => {
      failure = error;
      for (const item of pending.values()) item.reject(error);
      pending.clear();
    };
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stderr.resume();
    child.on('exit', code => fail(new Error(`Headroom exited (${code})`)));
    const abort = () => { fail(new Error('Headroom compression aborted')); child.kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { fail(new Error('Headroom compression timed out')); child.kill(); }, 60000);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        const value = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (value.id === undefined) return;
        const item = pending.get(value.id);
        if (!item) return;
        pending.delete(value.id);
        if (value.error) item.reject(new Error('Headroom MCP request failed'));
        else item.resolve(value.result);
      } catch { fail(new Error('Invalid Headroom MCP output')); }
    });
    const request = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
      if (failure) { reject(failure); return; }
      const next = ++id;
      pending.set(next, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n');
    });
    const decode = (value: unknown): Record<string, unknown> => {
      if (!value || typeof value !== 'object' || !('content' in value) || !Array.isArray(value.content)) {
        throw new Error('Invalid Headroom tool result');
      }
      const text = value.content.find((item: { type?: string }) => item.type === 'text')?.text;
      if (typeof text !== 'string') throw new Error('Headroom text result missing');
      const result: unknown = JSON.parse(text);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid Headroom result');
      return result as Record<string, unknown>;
    };
    try {
      await request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'nexus-ai-local', version: '1.0.0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const compressed = decode(await request('tools/call', { name: 'headroom_compress', arguments: { content: original } }));
      if (typeof compressed.hash !== 'string' || typeof compressed.compressed !== 'string'
        || typeof compressed.original_tokens !== 'number' || typeof compressed.compressed_tokens !== 'number') {
        throw new Error('Headroom compression shape invalid');
      }
      const retrieved = decode(await request('tools/call', { name: 'headroom_retrieve', arguments: { hash: compressed.hash } }));
      if (retrieved.original_content !== original) throw new Error('Headroom original verification failed');
      return { compressed: compressed.compressed, originalTokens: compressed.original_tokens,
        compressedTokens: compressed.compressed_tokens, originalVerified: true };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      lines.close();
      child.stdin.end();
      child.kill();
    }
  }
}
