import type { ModelProvider, ModelProviderStatus, AIModelMode, ProviderRole } from './modelRouter.ts';
import type { AIProviderHealth } from './aiProviderRouter.ts';

interface GeminiProxyResponse {
  status?: AIProviderHealth['status'];
  model?: string;
  message?: string;
  gemini?: AIProviderHealth;
}

const buildEnv = import.meta.env;
const defaultBaseUrl = buildEnv?.VITE_NEXUS_AGENT_HUB_URL || 'http://127.0.0.1:8788';

export class GeminiProxyProvider implements ModelProvider {
  readonly name = 'Google Gemini';
  readonly id = 'google-gemini';
  readonly capabilities = ['ai.chat', 'ai.code', 'ai.analyze', 'ai.stream'];
  readonly priority = 100;
  readonly costClass = 'paid' as const;
  readonly local = false;
  readonly mode: AIModelMode = 'CLOUD';
  readonly role: ProviderRole = 'PRIMARY_ORCHESTRATOR';

  private readonly baseUrl: string;

  constructor(baseUrl = defaultBaseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async checkHealth(): Promise<{
    status: ModelProviderStatus;
    model?: string;
    error?: string;
    models?: unknown[];
  }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/ai/health`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { status: 'ERROR', error: `Nexus AI bridge returned HTTP ${response.status}` };
      const data = await response.json() as GeminiProxyResponse;
      const health = data.gemini ?? data as AIProviderHealth;
      const statusByHealth: Record<AIProviderHealth['status'], ModelProviderStatus> = {
        healthy: 'CONNECTED',
        unavailable: 'UNAVAILABLE',
        unauthenticated: 'ERROR',
        quota_exceeded: 'QUOTA_EXCEEDED',
        rate_limited: 'RATE_LIMITED',
        offline: 'OFFLINE',
        model_missing: 'NO_MODEL',
        not_configured: 'NOT_CONFIGURED',
        error: 'ERROR',
      };
      const status = statusByHealth[health.status] ?? 'ERROR';
      return { status, model: health.model, error: health.message };
    } catch {
      return { status: 'OFFLINE', error: 'Nexus AI bridge is unreachable.' };
    }
  }

  async listModels(): Promise<unknown[]> {
    const health = await this.checkHealth();
    return health.model ? [{ name: health.model }] : [];
  }

  async generate(prompt: string, options: Record<string, unknown> = {}): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/ai/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        temperature: options.temperature,
        maxOutputTokens: options.maxOutputTokens ?? options.numPredict,
        mode: options.mode ?? 'AUTO',
      }),
      signal: options.signal instanceof AbortSignal ? options.signal : AbortSignal.timeout(90000),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Nexus AI bridge failed (HTTP ${response.status})`);
    }
    const result = await response.json() as { text?: string };
    if (typeof result.text !== 'string' || !result.text) throw new Error('Nexus AI bridge returned an empty response.');
    return result.text;
  }
}
