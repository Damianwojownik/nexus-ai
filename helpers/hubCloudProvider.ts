import type { AIModelMode, ModelProvider, ProviderRole } from './modelRouter.ts';

export class HubCloudProvider implements ModelProvider {
  readonly name = 'Cloud AI';
  readonly mode: AIModelMode = 'CLOUD';
  readonly role: ProviderRole = 'PRIMARY_ORCHESTRATOR';
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(90000),
    });
    if (!response.ok) {
      let message = `Cloud AI request failed: HTTP ${response.status}`;
      try {
        const body = await response.json() as { error?: string };
        if (body.error) message = body.error;
      } catch {}
      throw new Error(message);
    }
    return response.json() as Promise<T>;
  }

  async checkHealth() {
    const result = await this.request<{ status: 'CONNECTED' | 'NOT_CONFIGURED' | 'ERROR'; model?: string; error?: string }>('/api/ai/health');
    return {
      status: result.status === 'NOT_CONFIGURED' ? 'OFFLINE' as const : result.status,
      model: result.model,
      error: result.error,
    };
  }

  async listModels(): Promise<any[]> {
    const result = await this.request<{ models: any[] }>('/api/ai/models');
    return result.models;
  }

  async generate(prompt: string, options: Record<string, any> = {}): Promise<string> {
    const result = await this.request<{ text: string }>('/api/ai/generate', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        system: options.system,
        temperature: options.temperature,
        maxTokens: options.numPredict ?? options.maxTokens,
      }),
    });
    return result.text;
  }
}
