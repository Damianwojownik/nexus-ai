export type ConnectorHealth = {
  id: string;
  name: string;
  transport: 'github-cli' | 'mcp-http';
  status: 'CONNECTED' | 'NOT_CONFIGURED' | 'OFFLINE' | 'ERROR';
  error?: string;
  toolCount?: number;
};

export type ConnectorTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown> & {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
};

const buildEnv = import.meta.env;
const processEnv = typeof process !== 'undefined' ? process.env : undefined;
const defaultBaseUrl = buildEnv?.VITE_NEXUS_AGENT_HUB_URL || processEnv?.NEXUS_AGENT_HUB_URL || 'http://127.0.0.1:8788';

export class ConnectorClient {
  readonly baseUrl: string;

  constructor(baseUrl = defaultBaseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(30000),
    });
    const body = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new Error(body?.error || `Connector request failed with HTTP ${response.status}`);
    return body as T;
  }

  async health(): Promise<ConnectorHealth[]> {
    const result = await this.request<{ connectors: ConnectorHealth[] }>('/api/connectors');
    return result.connectors;
  }

  async listTools(connectorId: string): Promise<ConnectorTool[]> {
    const result = await this.request<{ connector: string; tools: ConnectorTool[] }>(
      `/api/connectors/${encodeURIComponent(connectorId)}/tools`,
    );
    return result.tools;
  }

  async callTool(
    connectorId: string,
    tool: string,
    args: Record<string, unknown> = {},
    confirmed = false,
  ): Promise<unknown> {
    const result = await this.request<{ connector: string; tool: string; result: unknown }>(
      `/api/connectors/${encodeURIComponent(connectorId)}/call`,
      {
        method: 'POST',
        body: JSON.stringify({ tool, args, confirmed }),
      },
    );
    return result.result;
  }
}

export const connectorClient = new ConnectorClient();
