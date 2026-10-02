import { execFile } from 'node:child_process';

export type ConnectorTransport = 'github-cli' | 'mcp-http';

export type ConnectorManifest = {
  id: string;
  name: string;
  transport: ConnectorTransport;
  url?: string;
  tokenEnv?: string;
  protocolVersion?: string;
  enabled?: boolean;
};

export type ConnectorHealth = {
  id: string;
  name: string;
  transport: ConnectorTransport;
  status: 'CONNECTED' | 'NOT_CONFIGURED' | 'OFFLINE' | 'ERROR';
  error?: string;
  toolCount?: number;
};

export type ConnectorTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    [key: string]: unknown;
  };
};

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
};

type ConnectorEnv = Record<string, string | undefined>;

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/i;
const TOOL_RE = /^[a-zA-Z0-9_.:/-]{1,160}$/;

function safeUrl(raw: string): URL {
  const url = new URL(raw);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Connector URL must use HTTPS, except loopback HTTP is allowed');
  }
  if (url.username || url.password) throw new Error('Connector URL must not embed credentials');
  return url;
}

export function parseConnectorManifests(raw: string | undefined): ConnectorManifest[] {
  if (!raw?.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('NEXUS_CONNECTORS_JSON must be valid JSON');
  }
  if (!Array.isArray(value)) throw new Error('NEXUS_CONNECTORS_JSON must be an array');

  const ids = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Connector entry ${index} must be an object`);
    }
    const data = item as Record<string, unknown>;
    const id = String(data.id ?? '').trim();
    const name = String(data.name ?? '').trim();
    const transport = String(data.transport ?? '').trim() as ConnectorTransport;
    if (!ID_RE.test(id)) throw new Error(`Connector entry ${index} has an invalid id`);
    if (!name) throw new Error(`Connector ${id} requires a name`);
    if (ids.has(id)) throw new Error(`Duplicate connector id: ${id}`);
    ids.add(id);
    if (transport !== 'mcp-http') {
      throw new Error(`Connector ${id} uses unsupported transport: ${transport || 'missing'}`);
    }
    const url = String(data.url ?? '').trim();
    if (!url) throw new Error(`Connector ${id} requires url`);
    safeUrl(url);
    const tokenEnv = typeof data.tokenEnv === 'string' && data.tokenEnv.trim() ? data.tokenEnv.trim() : undefined;
    if (tokenEnv && !/^[A-Z0-9_]{2,120}$/.test(tokenEnv)) throw new Error(`Connector ${id} has an invalid tokenEnv`);
    return {
      id,
      name,
      transport,
      url,
      tokenEnv,
      protocolVersion: typeof data.protocolVersion === 'string' && data.protocolVersion.trim()
        ? data.protocolVersion.trim()
        : '2025-03-26',
      enabled: data.enabled !== false,
    };
  }).filter((item) => item.enabled !== false);
}

function exec(command: string, args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      shell: process.platform === 'win32',
    }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message || `${command} failed`).trim()));
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function parseSseJson(text: string): JsonRpcResponse {
  const events = text
    .split(/\r?\n\r?\n/)
    .map((chunk) => chunk.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'))
    .filter(Boolean);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(events[index]) as JsonRpcResponse;
    } catch {
      // Keep scanning prior SSE events until a JSON-RPC payload is found.
    }
  }
  throw new Error('MCP connector returned SSE without a JSON-RPC payload');
}

class McpHttpConnector {
  private sessionId?: string;
  private requestId = 1;

  constructor(
    readonly manifest: ConnectorManifest,
    private readonly env: ConnectorEnv,
  ) {}

  private headers(extra: Record<string, string> = {}) {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...extra,
    };
    if (this.manifest.tokenEnv) {
      const token = (this.env[this.manifest.tokenEnv] ?? '').trim();
      if (token) headers.Authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  private configured(): boolean {
    return !this.manifest.tokenEnv || !!(this.env[this.manifest.tokenEnv] ?? '').trim();
  }

  private async rpc(method: string, params?: Record<string, unknown>, notification = false): Promise<any> {
    if (!this.configured()) throw new Error(`Missing environment variable ${this.manifest.tokenEnv}`);
    const body: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (!notification) body.id = this.requestId++;
    if (params) body.params = params;

    const response = await fetch(this.manifest.url!, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;
    const text = await response.text();
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 300)}`);
    if (notification || response.status === 202 || !text.trim()) return undefined;
    const payload = response.headers.get('content-type')?.includes('text/event-stream')
      ? parseSseJson(text)
      : JSON.parse(text) as JsonRpcResponse;
    if (payload.error) throw new Error(payload.error.message || `MCP error ${payload.error.code ?? ''}`.trim());
    return payload.result;
  }

  private async ensureInitialized() {
    if (this.sessionId) return;
    await this.rpc('initialize', {
      protocolVersion: this.manifest.protocolVersion ?? '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'Nexus', version: '1.0.0' },
    });
    await this.rpc('notifications/initialized', undefined, true).catch(() => undefined);
  }

  async listTools(): Promise<ConnectorTool[]> {
    await this.ensureInitialized();
    const result = await this.rpc('tools/list');
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools
      .filter((tool: any) => typeof tool?.name === 'string' && TOOL_RE.test(tool.name))
      .map((tool: any) => ({
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : undefined,
        inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : undefined,
        annotations: tool.annotations && typeof tool.annotations === 'object' ? tool.annotations : undefined,
      }));
  }

  async health(): Promise<ConnectorHealth> {
    if (!this.configured()) {
      return {
        id: this.manifest.id,
        name: this.manifest.name,
        transport: 'mcp-http',
        status: 'NOT_CONFIGURED',
        error: `Missing environment variable ${this.manifest.tokenEnv}`,
      };
    }
    try {
      const tools = await this.listTools();
      return {
        id: this.manifest.id,
        name: this.manifest.name,
        transport: 'mcp-http',
        status: 'CONNECTED',
        toolCount: tools.length,
      };
    } catch (error) {
      return {
        id: this.manifest.id,
        name: this.manifest.name,
        transport: 'mcp-http',
        status: 'OFFLINE',
        error: error instanceof Error ? error.message : 'MCP connector unavailable',
      };
    }
  }

  async callTool(name: string, args: Record<string, unknown>, confirmed: boolean): Promise<unknown> {
    if (!TOOL_RE.test(name)) throw new Error('Invalid connector tool name');
    const tools = await this.listTools();
    const tool = tools.find((item) => item.name === name);
    if (!tool) throw new Error(`Connector tool not found: ${name}`);
    const readOnly = tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true;
    if (!readOnly && !confirmed) {
      throw new Error(`Connector tool ${name} requires explicit approval`);
    }
    await this.ensureInitialized();
    return await this.rpc('tools/call', { name, arguments: args });
  }
}

class GitHubCliConnector {
  readonly manifest: ConnectorManifest = {
    id: 'github',
    name: 'GitHub',
    transport: 'github-cli',
    enabled: true,
  };

  readonly tools: ConnectorTool[] = [
    {
      name: 'repo_view',
      description: 'Read metadata for a GitHub repository accessible to the signed-in gh CLI user.',
      inputSchema: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'read_file',
      description: 'Read one UTF-8 file from a GitHub repository through gh api.',
      inputSchema: {
        type: 'object',
        properties: { repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' } },
        required: ['repo', 'path'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'search_repositories',
      description: 'Search GitHub repositories through gh api.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
  ];

  async health(): Promise<ConnectorHealth> {
    try {
      await exec('gh', ['auth', 'status'], 10000);
      return {
        id: this.manifest.id,
        name: this.manifest.name,
        transport: 'github-cli',
        status: 'CONNECTED',
        toolCount: this.tools.length,
      };
    } catch (error) {
      return {
        id: this.manifest.id,
        name: this.manifest.name,
        transport: 'github-cli',
        status: 'OFFLINE',
        error: error instanceof Error ? error.message : 'GitHub CLI unavailable',
      };
    }
  }

  async listTools() {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === 'repo_view') {
      const repo = String(args.repo ?? '').trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo must be owner/name');
      const result = await exec('gh', ['repo', 'view', repo, '--json', 'nameWithOwner,description,url,defaultBranchRef,isPrivate']);
      return JSON.parse(result.stdout);
    }
    if (name === 'read_file') {
      const repo = String(args.repo ?? '').trim();
      const path = String(args.path ?? '').trim().replace(/^\/+/, '');
      const ref = String(args.ref ?? '').trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo must be owner/name');
      if (!path || path.includes('..')) throw new Error('path must be a safe repository-relative path');
      const endpoint = `repos/${repo}/contents/${path}`;
      const query = ref ? ['-f', `ref=${ref}`] : [];
      const result = await exec('gh', ['api', endpoint, ...query, '--jq', '.content']);
      const base64 = result.stdout.replace(/\s+/g, '');
      return { repo, path, ref: ref || undefined, content: Buffer.from(base64, 'base64').toString('utf8') };
    }
    if (name === 'search_repositories') {
      const query = String(args.query ?? '').trim();
      if (!query || query.length > 300) throw new Error('query must contain 1 to 300 characters');
      const result = await exec('gh', ['api', 'search/repositories', '-f', `q=${query}`, '-f', 'per_page=10']);
      const data = JSON.parse(result.stdout);
      return {
        items: Array.isArray(data?.items)
          ? data.items.map((item: any) => ({
            fullName: item.full_name,
            description: item.description,
            url: item.html_url,
            stars: item.stargazers_count,
          }))
          : [],
      };
    }
    throw new Error(`GitHub connector tool not found: ${name}`);
  }
}

export class ConnectorRegistry {
  private readonly github?: GitHubCliConnector;
  private readonly mcp = new Map<string, McpHttpConnector>();

  constructor(
    private readonly env: ConnectorEnv = process.env,
    options: { includeGitHub?: boolean } = {},
  ) {
    if (options.includeGitHub !== false && (env.NEXUS_GITHUB_CONNECTOR_DISABLED ?? '').trim() !== '1') {
      this.github = new GitHubCliConnector();
    }
    const manifests = parseConnectorManifests(env.NEXUS_CONNECTORS_JSON);
    for (const manifest of manifests) this.mcp.set(manifest.id, new McpHttpConnector(manifest, env));
  }

  listManifests(): ConnectorManifest[] {
    return [
      ...(this.github ? [this.github.manifest] : []),
      ...[...this.mcp.values()].map((connector) => connector.manifest),
    ];
  }

  async health(): Promise<ConnectorHealth[]> {
    return await Promise.all([
      ...(this.github ? [this.github.health()] : []),
      ...[...this.mcp.values()].map((connector) => connector.health()),
    ]);
  }

  async listTools(id: string): Promise<ConnectorTool[]> {
    if (id === 'github' && this.github) return this.github.listTools();
    const connector = this.mcp.get(id);
    if (!connector) throw new Error(`Connector not found: ${id}`);
    return connector.listTools();
  }

  async callTool(id: string, name: string, args: Record<string, unknown>, confirmed = false): Promise<unknown> {
    if (id === 'github' && this.github) return this.github.callTool(name, args);
    const connector = this.mcp.get(id);
    if (!connector) throw new Error(`Connector not found: ${id}`);
    return connector.callTool(name, args, confirmed);
  }
}
