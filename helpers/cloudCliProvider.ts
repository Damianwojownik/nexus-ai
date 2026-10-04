import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AIProvider, AIProviderGenerationOptions, AIProviderHealth } from './aiProviderRouter.ts';
import { AIProviderRequestError } from './aiProviderRouter.ts';

export type CloudCliKind = 'copilot' | 'codex' | 'claude';
export function cloudCliArguments(kind: CloudCliKind, prompt: string, output: string): string[] {
  if (kind === 'codex') return ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral',
    '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false',
    '-c', 'web_search="disabled"', '--output-last-message', output, prompt];
  if (kind === 'claude') return ['-p', prompt, '--output-format', 'text', '--tools', '', '--no-session-persistence',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--setting-sources', ''];
  return ['-p', prompt, '-s', '--no-ask-user', '--available-tools', ''];
}

export class CloudCliProvider implements AIProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities = ['ai.chat'];
  readonly costClass = 'included' as const;
  readonly isLocal = false;
  readonly priority: number;
  private readonly executable: string;
  private readonly prefix: string[];
  private readonly kind: CloudCliKind;
  private copilotVerified = false;
  private lastCopilotHealth?: { checkedAt: number; health: AIProviderHealth };

  constructor(kind: CloudCliKind) {
    this.kind = kind;
    this.id = `${kind}-cli`;
    this.name = kind === 'codex' ? 'GPT / Codex (ChatGPT login)' : `${kind} CLI`;
    this.priority = kind === 'codex' ? 300 : kind === 'copilot' ? 200 : 150;
    const globalModules = join(process.env.APPDATA ?? '', 'npm', 'node_modules');
    this.executable = kind === 'claude'
      ? join(globalModules, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
      : process.execPath;
    this.prefix = kind === 'claude' ? [] : [kind === 'codex'
      ? join(globalModules, '@openai', 'codex', 'bin', 'codex.js')
      : join(globalModules, '@github', 'copilot', 'npm-loader.js')];
  }

  private run(args: string[], cwd: string, options: AIProviderGenerationOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(this.executable, [...this.prefix, ...args], {
        cwd, windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024,
        signal: options.signal,
      }, (error, stdout, stderr) => {
        if (error) {
          if (options.signal?.aborted) reject(options.signal.reason);
          else {
            const diagnostic = `${stdout}\n${stderr}`.toLowerCase();
            const status = /not logged in|no authentication|unauthorized|login required|"loggedin"\s*:\s*false/.test(diagnostic) ? 'unauthenticated'
              : /quota|usage limit|credits|points/.test(diagnostic) ? 'quota_exceeded'
              : /rate.limit|too many requests/.test(diagnostic) ? 'rate_limited' : 'unavailable';
            reject(new AIProviderRequestError(`${this.name}: ${status} (process ${error.code ?? error.name}). Check its terminal login or subscription limits.`, status));
          }
          return;
        }
        resolve(stdout.trim());
      });
      child.stdin?.end();
    });
  }

  async healthCheck(): Promise<AIProviderHealth> {
    if (this.kind === 'copilot' && this.lastCopilotHealth && Date.now() - this.lastCopilotHealth.checkedAt < 60000) {
      return this.lastCopilotHealth.health;
    }
    try {
      await access(this.prefix[0] ?? this.executable);
      if (this.kind === 'copilot' && !this.copilotVerified) {
        await this.generate('Reply exactly NEXUS_CONNECTED. Do not use tools.', { signal: AbortSignal.timeout(10000) });
        this.copilotVerified = true;
      }
      const output = await this.run(this.kind === 'codex' ? ['login', 'status']
        : this.kind === 'claude' ? ['auth', 'status'] : ['--version'], tmpdir());
      if (this.kind === 'claude') {
        const status: unknown = JSON.parse(output);
        if (!status || typeof status !== 'object' || !('loggedIn' in status) || status.loggedIn !== true) {
          return { status: 'unauthenticated', message: 'Run claude auth login in a terminal.' };
        }
      }
      const health: AIProviderHealth = { status: 'healthy', message: this.kind === 'copilot' ? 'Account generation verified.' : 'CLI logged in. Quota is verified during generation.' };
      if (this.kind === 'copilot') this.lastCopilotHealth = { checkedAt: Date.now(), health };
      return health;
    } catch (error) {
      console.error(`[nexus:${this.id}] health check failed`, error instanceof Error ? error.message : 'unknown error');
      const health: AIProviderHealth = { status: error instanceof AIProviderRequestError ? error.status : 'unavailable', message: 'CLI unavailable or not logged in. Check its terminal login.' };
      if (this.kind === 'copilot') this.lastCopilotHealth = { checkedAt: Date.now(), health };
      return health;
    }
  }

  async generate(prompt: string, options: AIProviderGenerationOptions = {}): Promise<string> {
    if (!prompt.trim() || prompt.length > 24000) throw new Error('CLI prompt must contain 1 to 24000 characters.');
    const cwd = await mkdtemp(join(tmpdir(), 'nexus-cloud-chat-'));
    try {
      const output = join(cwd, 'reply.txt');
      const stdout = await this.run(cloudCliArguments(this.kind, prompt, output), cwd, options);
      const result = this.kind === 'codex' ? (await readFile(output, 'utf8')).trim() : stdout;
      if (!result) throw new Error(`${this.name} returned an empty response.`);
      return result;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
