export type CloudAIHealthStatus = 'CONNECTED' | 'NOT_CONFIGURED' | 'ERROR';

export interface CloudAIHealth {
  status: CloudAIHealthStatus;
  provider: string;
  model?: string;
  error?: string;
}

export interface CloudAIGenerateInput {
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

export class OpenAICompatibleCloudClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly providerName: string;

  constructor() {
    this.baseUrl = env('NEXUS_CLOUD_AI_BASE_URL').replace(/\/$/, '');
    this.apiKey = env('NEXUS_CLOUD_AI_API_KEY');
    this.model = env('NEXUS_CLOUD_AI_MODEL');
    this.providerName = env('NEXUS_CLOUD_AI_NAME') || 'Cloud AI';
  }

  isConfigured(): boolean {
    return !!(this.baseUrl && this.apiKey && this.model);
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  async health(): Promise<CloudAIHealth> {
    if (!this.isConfigured()) {
      return { status: 'NOT_CONFIGURED', provider: this.providerName, model: this.model || undefined };
    }
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) {
        return { status: 'ERROR', provider: this.providerName, model: this.model, error: `HTTP ${response.status}` };
      }
      return { status: 'CONNECTED', provider: this.providerName, model: this.model };
    } catch (error) {
      return {
        status: 'ERROR',
        provider: this.providerName,
        model: this.model,
        error: error instanceof Error ? error.message : 'Cloud provider health check failed',
      };
    }
  }

  async listModels(): Promise<any[]> {
    if (!this.isConfigured()) return [];
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return [];
    const data = await response.json() as any;
    return Array.isArray(data?.data) ? data.data : [];
  }

  async generate(input: CloudAIGenerateInput): Promise<string> {
    if (!this.isConfigured()) throw new Error('Cloud AI is not configured');
    const messages = [
      ...(input.system ? [{ role: 'system', content: input.system }] : []),
      { role: 'user', content: input.prompt },
    ];
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: input.temperature ?? 0.2,
        max_tokens: input.maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(90000),
    });
    const data = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      const message = data?.error?.message || data?.message || `Cloud AI HTTP ${response.status}`;
      throw new Error(message);
    }
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Cloud AI returned an empty response');
    return text;
  }
}
