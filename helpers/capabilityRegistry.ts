export type ConnectorHealthStatus =
  | 'healthy'
  | 'unavailable'
  | 'unauthenticated'
  | 'rate_limited'
  | 'not_configured'
  | 'error';

export interface ConnectorHealth {
  status: ConnectorHealthStatus;
  message?: string;
}

export interface ConnectorCapability {
  id: string;
  name: string;
  readOnly: boolean;
}

export interface ToolConnector {
  readonly id: string;
  readonly name: string;
  readonly authType: 'none' | 'token' | 'oauth' | 'local';
  readonly priority: number;
  readonly capabilities: readonly ConnectorCapability[];
  healthCheck(): Promise<ConnectorHealth>;
  execute(capability: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export interface CapabilityAvailability extends ConnectorCapability {
  connectorId: string;
  connectorName: string;
  status: ConnectorHealthStatus;
  message?: string;
}

export class CapabilityRegistry {
  private readonly connectors = new Map<string, ToolConnector>();

  register(connector: ToolConnector): void {
    if (this.connectors.has(connector.id)) throw new Error(`Connector is already registered: ${connector.id}`);
    this.connectors.set(connector.id, connector);
  }

  listConnectors(): ToolConnector[] {
    return [...this.connectors.values()].sort((left, right) => right.priority - left.priority);
  }

  async listCapabilities(): Promise<CapabilityAvailability[]> {
    const entries = await Promise.all(this.listConnectors().flatMap((connector) =>
      connector.capabilities.map(async (capability) => {
        let health: ConnectorHealth;
        try {
          health = await connector.healthCheck();
        } catch {
          health = { status: 'error', message: 'Connector health check failed.' };
        }
        return {
          ...capability,
          connectorId: connector.id,
          connectorName: connector.name,
          status: health.status,
          message: health.message,
        };
      })));
    return entries;
  }

  async execute(
    capabilityId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ connectorId: string; result: unknown }> {
    const candidates = this.listConnectors()
      .filter((connector) => connector.capabilities.some((capability) => capability.id === capabilityId));
    if (!candidates.length) throw new Error(`Capability is not registered: ${capabilityId}`);

    const isReadOnly = candidates.every((connector) =>
      connector.capabilities.find((capability) => capability.id === capabilityId)?.readOnly === true);
    const failures: string[] = [];
    for (const connector of candidates) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
      let health: ConnectorHealth;
      try {
        health = await connector.healthCheck();
      } catch {
        health = { status: 'error', message: 'Connector health check failed.' };
      }
      if (health.status !== 'healthy') {
        failures.push(`${connector.id}: ${health.status}`);
        continue;
      }
      try {
        return { connectorId: connector.id, result: await connector.execute(capabilityId, args, signal) };
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        failures.push(`${connector.id}: execution failed`);
        if (!isReadOnly) throw error;
      }
    }
    throw new Error(`No connector completed ${capabilityId}${failures.length ? ` (${failures.join('; ')})` : ''}.`);
  }
}

const githubCapabilities: ConnectorCapability[] = [
  { id: 'github.repo_discovery', name: 'Discover repositories', readOnly: true },
  { id: 'github.read', name: 'Read repository files', readOnly: true },
  { id: 'github.search', name: 'Search code', readOnly: true },
  { id: 'github.branches', name: 'List branches', readOnly: true },
  { id: 'github.commits', name: 'List commits', readOnly: true },
  { id: 'github.pull_requests', name: 'List pull requests', readOnly: true },
  { id: 'github.issues', name: 'List issues', readOnly: true },
  { id: 'github.assets', name: 'List release assets', readOnly: true },
  { id: 'github.asset_download', name: 'Download a release asset', readOnly: true },
];

const maxAssetBytes = 10 * 1024 * 1024;

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`GitHub release asset exceeds ${maxBytes / 1024 / 1024} MB.`);
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function requiredArgument(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

export class GitHubConnector implements ToolConnector {
  readonly id = 'github';
  readonly name = 'GitHub';
  readonly authType = 'token' as const;
  readonly priority = 100;
  readonly capabilities = githubCapabilities;

  private readonly token: string;
  private readonly fetcher: typeof fetch;

  constructor(options: { token?: string; fetcher?: typeof fetch } = {}) {
    this.token = options.token ?? process.env.NEXUS_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
    this.fetcher = options.fetcher ?? fetch;
  }

  async healthCheck(): Promise<ConnectorHealth> {
    if (!this.token) return { status: 'not_configured', message: 'Set NEXUS_GITHUB_TOKEN to enable GitHub access.' };
    try {
      const response = await this.fetcher('https://api.github.com/user', {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return { status: 'healthy' };
      if (response.status === 401 || response.status === 403) return { status: 'unauthenticated', message: `GitHub authorization failed (HTTP ${response.status}).` };
      if (response.status === 429) return { status: 'rate_limited', message: 'GitHub rate limit reached.' };
      return { status: 'unavailable', message: `GitHub returned HTTP ${response.status}.` };
    } catch {
      return { status: 'unavailable', message: 'GitHub API is unreachable.' };
    }
  }

  async execute(capability: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const endpoint = this.endpointFor(capability, args);
    const response = await this.fetcher(`https://api.github.com${endpoint}`, {
      headers: {
        ...this.headers(),
        ...(capability === 'github.asset_download' ? { Accept: 'application/octet-stream' } : {}),
      },
      signal: signal ?? AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const status = response.status === 401 || response.status === 403
        ? 'authorization failed'
        : response.status === 429 ? 'rate limited' : `HTTP ${response.status}`;
      throw new Error(`GitHub request ${status}.`);
    }

    if (capability === 'github.asset_download') {
      const bytes = await readLimitedBody(response, maxAssetBytes);
      const disposition = response.headers.get('content-disposition') ?? '';
      const name = disposition.match(/filename="?([^";]+)"?/i)?.[1]?.replace(/[\\/:*?"<>|]/g, '_') ?? 'release-asset';
      return {
        filename: name,
        mediaType: response.headers.get('content-type') ?? 'application/octet-stream',
        bytes: bytes.byteLength,
        contentBase64: Buffer.from(bytes).toString('base64'),
      };
    }

    const value: unknown = await response.json();
    if (capability === 'github.read' && isGitHubContent(value)) {
      return { path: value.path, sha: value.sha, content: Buffer.from(value.content.replace(/\s/g, ''), 'base64').toString('utf8') };
    }
    return value;
  }

  private endpointFor(capability: string, args: Record<string, unknown>): string {
    if (capability === 'github.repo_discovery') return '/user/repos?sort=updated&per_page=30';
    const owner = encodeURIComponent(requiredArgument(args, 'owner'));
    const repo = encodeURIComponent(requiredArgument(args, 'repo'));
    const repository = `/repos/${owner}/${repo}`;
    if (capability === 'github.read') {
      const path = typeof args.path === 'string' ? args.path.split('/').filter(Boolean).map(encodeURIComponent).join('/') : '';
      return `${repository}/contents${path ? `/${path}` : ''}`;
    }
    if (capability === 'github.branches') return `${repository}/branches?per_page=100`;
    if (capability === 'github.commits') return `${repository}/commits?per_page=30`;
    if (capability === 'github.pull_requests') return `${repository}/pulls?state=all&per_page=30`;
    if (capability === 'github.issues') return `${repository}/issues?state=all&per_page=30`;
    if (capability === 'github.assets') return `${repository}/releases?per_page=10`;
    if (capability === 'github.asset_download') {
      const assetId = requiredArgument(args, 'assetId');
      if (!/^\d+$/.test(assetId)) throw new Error('assetId must be a numeric GitHub release asset ID.');
      return `${repository}/releases/assets/${assetId}`;
    }
    if (capability === 'github.search') {
      const query = requiredArgument(args, 'query');
      const search = new URLSearchParams({ q: `${query} repo:${requiredArgument(args, 'owner')}/${requiredArgument(args, 'repo')}`, per_page: '30' });
      return `/search/code?${search.toString()}`;
    }
    throw new Error(`Unsupported GitHub capability: ${capability}`);
  }

  private headers(): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }
}

function isGitHubContent(value: unknown): value is { type: 'file'; path: string; sha: string; content: string } {
  return typeof value === 'object'
    && value !== null
    && 'type' in value
    && value.type === 'file'
    && 'content' in value
    && typeof value.content === 'string'
    && 'path' in value
    && typeof value.path === 'string'
    && 'sha' in value
    && typeof value.sha === 'string';
}
