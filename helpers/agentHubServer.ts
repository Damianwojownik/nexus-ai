import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { AgentHub } from './agentHub.ts';
import { createTask } from './agentProtocol.ts';
import type { AgentKind, AgentResult, AgentTaskStatus } from './agentProtocol.ts';
import { LocalCapabilities, LocalCapabilityError } from './localCapabilities.ts';
import { AIProviderRouter, AIProviderUnavailableError } from './aiProviderRouter.ts';
import type { AIRoutingMode } from './aiProviderRouter.ts';
import { GeminiAIProvider } from './geminiAIProvider.ts';
import { OllamaHttpProvider } from './ollamaHttpProvider.ts';
import { CapabilityRegistry, GitHubConnector } from './capabilityRegistry.ts';
import type { ToolConnector } from './capabilityRegistry.ts';

const taskStatuses: AgentTaskStatus[] = ['TODO', 'WORKING', 'BLOCKED', 'DONE'];
const agentKinds: AgentKind[] = ['orchestrator', 'primary', 'codex', 'ollama', 'reviewer', 'researcher', 'memory', 'tool'];

export interface AgentHubServerOptions {
  allowedOrigins?: string[];
  workspaceDir?: string;
  aiRouter?: AIProviderRouter;
  capabilityRegistry?: CapabilityRegistry;
  connectors?: ToolConnector[];
}

class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, `Request body exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB`);
    chunks.push(buffer);
  }

  if (size === 0) return {};

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
  if (!isRecord(value)) throw new HttpError(400, 'Request body must be a JSON object');
  return value;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${key} is required`);
  }
  return value.trim();
}

function createDefaultCapabilityRegistry(localCapabilities: LocalCapabilities, connectors: ToolConnector[] = []): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register({
    id: 'browser-search',
    name: 'Local web search',
    authType: 'none',
    priority: 100,
    capabilities: [{ id: 'browser.search', name: 'Search the web', readOnly: true }],
    async healthCheck() {
      return { status: 'healthy' };
    },
    async execute(capability, args) {
      if (capability !== 'browser.search') throw new Error(`Unsupported browser capability: ${capability}`);
      if (typeof args.query !== 'string' || !args.query.trim()) throw new HttpError(400, 'query is required');
      return localCapabilities.searchWeb(args.query);
    },
  });
  registry.register(new GitHubConnector());
  for (const connector of connectors) registry.register(connector);
  return registry;
}

function parseRoutingMode(value: unknown): AIRoutingMode {
  if (value === undefined) return 'AUTO';
  if (value === 'AUTO' || value === 'LOCAL' || value === 'CLOUD') return value;
  throw new HttpError(400, 'mode must be AUTO, LOCAL, or CLOUD');
}

function requirePrompt(body: Record<string, unknown>): string {
  const prompt = requiredString(body, 'prompt');
  if (prompt.length > 64000) throw new HttpError(413, 'prompt exceeds 64000 characters');
  return prompt;
}

function streamEvents(hub: AgentHub, request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const unsubscribe = hub.subscribe((event) => {
    if (response.destroyed) return;
    response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const keepAlive = setInterval(() => {
    if (!response.destroyed) response.write(': keep-alive\n\n');
  }, 15000);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    unsubscribe();
  };

  response.on('close', close);
  request.on('aborted', close);
  response.write('retry: 3000\n\n');
  response.flushHeaders();
}

function isAllowedOrigin(origin: string, configuredOrigins: string[]): boolean {
  if (configuredOrigins.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return true;
    return url.protocol === 'https:' && url.hostname.endsWith('.sandbox.floot.app');
  } catch {
    return false;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

export function createAgentHubServer(hub: AgentHub, options: AgentHubServerOptions = {}): Server {
  const localCapabilities = new LocalCapabilities(options.workspaceDir ?? join(process.cwd(), 'workspace'));
  const aiRouter = options.aiRouter ?? new AIProviderRouter([new GeminiAIProvider(), new OllamaHttpProvider()]);
  const capabilityRegistry = options.capabilityRegistry ?? createDefaultCapabilityRegistry(localCapabilities, options.connectors);

  return createServer(async (request, response) => {
    const origin = request.headers.origin;
    const corsAllowed = !!origin && isAllowedOrigin(origin, options.allowedOrigins ?? []);
    if (corsAllowed) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type, Last-Event-ID');
      response.setHeader('Vary', 'Origin');
      if (request.headers['access-control-request-private-network'] === 'true') {
        response.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
    }

    if (request.method === 'OPTIONS') {
      if (origin && !corsAllowed) {
        sendJson(response, 403, { error: 'Origin is not allowed to access the local Agent Hub' });
        return;
      }
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const url = new URL(request.url ?? '/', 'http://nexus.local');
      const segments = url.pathname.split('/').filter(Boolean).map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          throw new HttpError(400, 'Invalid URL path encoding');
        }
      });
      const method = request.method ?? 'GET';

      if (segments[0] === 'api' && segments[1] === 'install' && origin && !isLoopbackOrigin(origin)) {
        throw new LocalCapabilityError(403, 'Software installation is only available from the local Nexus frontend');
      }

      if (method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/avatar/animate') {
        const body = await readJson(request, 256 * 1024);
        const portraitPath = body.portraitPath ?? undefined; // Optional now
        const text = body.text ?? undefined;
        const audioPath = body.audioPath ?? undefined;
        const lang = body.lang ?? 'pl';
        
        if (!text && !audioPath) {
          throw new HttpError(400, 'Either text or audioPath is required');
        }

        const animationScript = join(process.cwd(), '..', 'FasterLivePortrait', 'nexus_avatar_animator.py');
        const pythonExe = process.env.PYTHON_EXE || 'python';

        // Invoke animator subprocess (non-blocking)
        const { spawn } = await import('child_process');
        const args = [
          animationScript,
          '--lang', lang,
          '--mode', 'onnx',
          '--json',
        ];

        // Add portrait only if provided (auto-detect otherwise)
        if (portraitPath) {
          args.push('--portrait', portraitPath);
        }

        if (text) {
          args.push('--text', text);
        } else if (audioPath) {
          args.push('--audio', audioPath);
        }

        let stdout = '';
        let stderr = '';

        const proc = spawn(pythonExe, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 120_000,
        });

        proc.stdout?.on('data', (data) => {
          stdout += data.toString();
        });

        proc.stderr?.on('data', (data) => {
          stderr += data.toString();
        });

        proc.on('close', (code) => {
          if (code !== 0) {
            console.error(`Avatar animator failed: ${stderr}`);
          }
        });

        proc.on('error', (err) => {
          console.error(`Avatar animator process error: ${err.message}`);
        });

        // Return immediately with 202 Accepted; client polls /api/avatar/result/:id
        const jobId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        sendJson(response, 202, { jobId, status: 'processing' });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true });
        return;
      }
        const providers = await aiRouter.healthCheck();
        sendJson(response, 200, {
          gemini: providers['google-gemini'] ?? { status: 'not_configured' },
          ollama: providers['ollama-local'] ?? { status: 'unavailable' },
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/ai/generate') {
        const body = await readJson(request, 256 * 1024);
        const prompt = requirePrompt(body);
        const temperature = body.temperature;
        const maxOutputTokens = body.maxOutputTokens;
        if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
          throw new HttpError(400, 'temperature must be between 0 and 2');
        }
        if (maxOutputTokens !== undefined && (typeof maxOutputTokens !== 'number' || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32768)) {
          throw new HttpError(400, 'maxOutputTokens must be an integer between 1 and 32768');
        }
        const controller = new AbortController();
        const abortIfDisconnected = () => {
          if (!response.writableEnded) controller.abort(new DOMException('The client disconnected', 'AbortError'));
        };
        request.once('aborted', abortIfDisconnected);
        response.once('close', abortIfDisconnected);
        try {
          const result = await aiRouter.generate(prompt, {
            mode: parseRoutingMode(body.mode),
            signal: controller.signal,
            ...(temperature !== undefined ? { temperature } : {}),
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          });
          sendJson(response, 200, { text: result.text, providerId: result.providerId });
        } finally {
          request.off('aborted', abortIfDisconnected);
          response.off('close', abortIfDisconnected);
        }
        return;
      }

      if (method === 'POST' && url.pathname === '/api/ai/stream') {
        const body = await readJson(request, 256 * 1024);
        const prompt = requirePrompt(body);
        const mode = parseRoutingMode(body.mode);
        const controller = new AbortController();
        const abortIfDisconnected = () => {
          if (!response.writableEnded) controller.abort(new DOMException('The client disconnected', 'AbortError'));
        };
        request.once('aborted', abortIfDisconnected);
        response.once('close', abortIfDisconnected);
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        try {
          const result = await aiRouter.stream(prompt, (chunk) => {
            if (!response.destroyed) response.write(`event: token\ndata: ${JSON.stringify({ text: chunk })}\n\n`);
          }, { mode, signal: controller.signal });
          if (!response.destroyed) {
            response.write(`event: complete\ndata: ${JSON.stringify({ providerId: result.providerId })}\n\n`);
            response.end();
          }
        } catch (error) {
          if (!response.destroyed) {
            const message = error instanceof AIProviderUnavailableError
              ? error.message
              : error instanceof Error ? error.message : 'AI streaming failed';
            response.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
            response.end();
          }
        } finally {
          request.off('aborted', abortIfDisconnected);
          response.off('close', abortIfDisconnected);
        }
        return;
      }

      if (method === 'GET' && url.pathname === '/api/capabilities') {
        sendJson(response, 200, { capabilities: await capabilityRegistry.listCapabilities() });
        return;
      }

      if (method === 'POST' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'capabilities') {
        const body = await readJson(request);
        const args = body.args === undefined ? {} : body.args;
        if (!isRecord(args)) throw new HttpError(400, 'args must be a JSON object');
        const result = await capabilityRegistry.execute(segments[2], args);
        sendJson(response, 200, result);
        return;
      }

      if (method === 'GET' && url.pathname === '/api/events') {
        await hub.getAgents();
        if (request.headers.accept?.includes('text/event-stream')) {
          streamEvents(hub, request, response);
          return;
        }
        const requestedLimit = Number(url.searchParams.get('limit') ?? 20);
        const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.floor(requestedLimit))) : 20;
        sendJson(response, 200, { events: hub.getEventLog(limit) });
        return;
      }

      if (method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'search') {
        const query = url.searchParams.get('q') ?? '';
        sendJson(response, 200, await localCapabilities.searchWeb(query));
        return;
      }

      if (method === 'POST' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'workspace' && segments[2] === 'import') {
        const body = await readJson(request, 15 * 1024 * 1024);
        const file = await localCapabilities.importFile(body.filename, body.contentBase64);
        sendJson(response, 201, { file });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/workspace/files') {
        sendJson(response, 200, { files: await localCapabilities.listWorkspaceFiles() });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/workspace/file') {
        const file = await localCapabilities.readWorkspaceFile(url.searchParams.get('path'));
        sendJson(response, 200, { file });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/workspace/file') {
        const body = await readJson(request, 512 * 1024);
        const file = await localCapabilities.writeWorkspaceFile(body.path, body.content, body.confirmed);
        sendJson(response, 200, { file });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/install/catalog') {
        sendJson(response, 200, await localCapabilities.getInstallCatalog());
        return;
      }

      if (method === 'POST' && url.pathname === '/api/install/setup') {
        const body = await readJson(request);
        sendJson(response, 202, await localCapabilities.openInstallerSetup(body.confirmed));
        return;
      }

      if (method === 'POST' && url.pathname === '/api/install') {
        const body = await readJson(request);
        const operation = localCapabilities.startInstall(body.packageId, body.confirmed);
        sendJson(response, 202, { operation });
        return;
      }

      if (method === 'GET' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'install') {
        const operation = localCapabilities.getInstallOperation(segments[2]);
        if (!operation) throw new HttpError(404, 'Installation operation not found');
        sendJson(response, 200, { operation });
        return;
      }

      if (method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'agents') {
        sendJson(response, 200, { agents: await hub.getAgents() });
        return;
      }

      if (method === 'POST' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'agents') {
        const body = await readJson(request);
        const agentId = requiredString(body, 'agentId');
        const kind = requiredString(body, 'kind') as AgentKind;
        if (!agentKinds.includes(kind)) throw new HttpError(400, 'kind is not supported');
        const capabilities = body.capabilities ?? [];
        if (!Array.isArray(capabilities) || !capabilities.every((item) => typeof item === 'string')) {
          throw new HttpError(400, 'capabilities must be an array of strings');
        }
        const agent = await hub.registerAgent({ agentId, kind, capabilities });
        sendJson(response, 201, { agent });
        return;
      }

      if (method === 'POST' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'agents' && segments[3] === 'heartbeat') {
        const agents = await hub.getAgents();
        if (!agents.some((agent) => agent.agentId === segments[2])) throw new HttpError(404, 'Agent not found');
        sendJson(response, 200, { presence: await hub.heartbeat(segments[2]) });
        return;
      }

      if (method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'tasks') {
        await hub.getAgents();
        const status = url.searchParams.get('status');
        if (status && !taskStatuses.includes(status as AgentTaskStatus)) throw new HttpError(400, 'status is not supported');
        sendJson(response, 200, { tasks: hub.listTasks(status as AgentTaskStatus | undefined) });
        return;
      }

      if (method === 'POST' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'tasks') {
        const body = await readJson(request);
        const task = createTask({
          goal: requiredString(body, 'goal'),
          createdBy: requiredString(body, 'createdBy'),
          assignedTo: requiredString(body, 'assignedTo'),
          scope: requiredString(body, 'scope'),
          contextRefs: Array.isArray(body.contextRefs) ? body.contextRefs.filter((item): item is string => typeof item === 'string') : [],
        });
        sendJson(response, 201, { task: await hub.submitTask(task) });
        return;
      }

      if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'tasks') {
        await hub.getAgents();
        const taskId = segments[2];
        if (method === 'GET') {
          const task = hub.getTask(taskId);
          if (!task) throw new HttpError(404, 'Task not found');
          sendJson(response, 200, { task });
          return;
        }
      }

      if (method === 'POST' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'tasks') {
        await hub.getAgents();
        const taskId = segments[2];
        const action = segments[3];
        const body = await readJson(request);
        if (action === 'claim') {
          const task = await hub.claimTask(taskId, requiredString(body, 'agentId'));
          if (!task) throw new HttpError(409, 'Task is missing or leased by another agent');
          sendJson(response, 200, { task });
          return;
        }
        if (action === 'complete') {
          const result = body.result;
          if (!isRecord(result)
            || !['SUCCESS', 'ERROR', 'PARTIAL'].includes(String(result.status))
            || typeof result.summary !== 'string') {
            throw new HttpError(400, 'result must include a valid status and summary');
          }
          const task = await hub.completeTask(taskId, result as unknown as AgentResult);
          if (!task) throw new HttpError(404, 'Task not found');
          sendJson(response, 200, { task });
          return;
        }
        if (action === 'fail') {
          const task = await hub.failTask(taskId, requiredString(body, 'error'));
          if (!task) throw new HttpError(404, 'Task not found');
          sendJson(response, 200, { task });
          return;
        }
        if (action === 'lease') {
          const owner = requiredString(body, 'owner');
          const ttlMs = body.ttlMs ?? 300000;
          if (typeof ttlMs !== 'number' || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000) {
            throw new HttpError(400, 'ttlMs must be an integer between 1000 and 3600000');
          }
          const task = await hub.leaseTask(taskId, owner, ttlMs);
          if (!task) throw new HttpError(409, 'Task is missing or leased by another agent');
          sendJson(response, 200, { task });
          return;
        }
      }

      throw new HttpError(404, 'Route not found');
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const statusCode = error instanceof HttpError || error instanceof LocalCapabilityError
        ? error.statusCode
        : error instanceof AIProviderUnavailableError ? 503 : 500;
      const message = error instanceof Error ? error.message : 'Internal server error';
      sendJson(response, statusCode, { error: message });
    }
  });
}