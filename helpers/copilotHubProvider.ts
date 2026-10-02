import type { ModelProvider } from './modelRouter.ts';

export class CopilotHubProvider implements ModelProvider {
  readonly name = 'GitHub Copilot';
  readonly mode = 'CLOUD' as const;
  readonly role = 'PRIMARY_ORCHESTRATOR' as const;
  private readonly baseUrl: string;

  constructor(baseUrl = 'http://127.0.0.1:8788') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(130000),
    });
    const body = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new Error(body?.error || `Copilot bridge HTTP ${response.status}`);
    return body as T;
  }

  async checkHealth() {
    try {
      const health = await this.request<{ status: 'CONNECTED' | 'OFFLINE' | 'ERROR'; version?: string; error?: string }>('/api/ai/copilot/health');
      return { status: health.status, model: health.version, error: health.error };
    } catch (error) {
      return { status: 'OFFLINE' as const, error: error instanceof Error ? error.message : 'Copilot bridge unavailable' };
    }
  }

  async listModels() {
    return [];
  }

  async generate(prompt: string) {
    const result = await this.request<{ text: string }>('/api/ai/copilot', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    });
    return result.text;
  }
}
