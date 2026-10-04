import type { ModelProvider, ModelProviderStatus, AIModelMode, ProviderRole } from './modelRouter.ts';
import type { AIProviderHealth } from './aiProviderRouter.ts';

interface GeminiProxyResponse {
  status?: AIProviderHealth['status'] | ModelProviderStatus;
  model?: string;
  message?: string;
  gemini?: AIProviderHealth;
  cloud?: AIProviderHealth;
  ollama?: AIProviderHealth;
  ollamaCpuOnly?: boolean;
  freeOnly?: boolean;
  providers?: Record<string, AIProviderHealth> | Array<{ id: string; status: ModelProviderStatus; model?: string; error?: string }>;
}

const buildEnv = import.meta.env;
const defaultBaseUrl = buildEnv?.VITE_NEXUS_AGENT_HUB_URL || 'http://127.0.0.1:8788';

export class GeminiProxyProvider implements ModelProvider {
  readonly name = 'Nexus AI (GPT / Copilot / Claude / Gemini)';
  readonly id = 'google-gemini';
  readonly capabilities = ['ai.chat', 'ai.code', 'ai.analyze', 'ai.stream'];
  readonly priority = 100;
  readonly costClass = 'paid' as const;
  readonly local = false;
  readonly mode: AIModelMode = 'CLOUD';
  readonly role: ProviderRole = 'PRIMARY_ORCHESTRATOR';

  private readonly baseUrl: string;
  private cpuFallbackReady = false;
  private selectedProvider: 'auto' | 'chatgpt-plan' | 'copilot' | 'ollama' = 'auto';
  lastProvider = '';

  selectProvider(provider: 'auto' | 'chatgpt-plan' | 'copilot' | 'ollama'): void {
    this.selectedProvider = provider;
    this.lastProvider = '';
  }
  private readonly allowLocalFallback: boolean;
  private readonly allowCpuFallback: boolean;

  constructor(baseUrl = defaultBaseUrl, allowLocalFallback = true, allowCpuFallback = false) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.allowLocalFallback = allowLocalFallback;
    this.allowCpuFallback = allowCpuFallback;
  }

  async checkHealth(): Promise<{
    status: ModelProviderStatus;
    model?: string;
    error?: string;
    models?: unknown[];
    providers?: Record<string, AIProviderHealth>;
  }> {
    this.cpuFallbackReady = false;
    try {
      const response = await fetch(`${this.baseUrl}/api/ai/health`, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) return { status: 'ERROR', error: `Nexus AI bridge returned HTTP ${response.status}` };
      const data = await response.json() as GeminiProxyResponse;
      if (data.freeOnly && !Array.isArray(data.providers)) {
        if (this.selectedProvider !== 'auto' && this.selectedProvider !== 'ollama') {
          return { status: 'NOT_CONFIGURED', error: 'Only free local Ollama is enabled.', providers: data.providers };
        }
        const local = data.ollama;
        return { status: local?.status === 'healthy' ? 'CONNECTED' : local?.status === 'model_missing' ? 'NO_MODEL' : 'OFFLINE',
          model: local?.model, error: local?.message, providers: data.providers };
      }
      if (Array.isArray(data.providers)) {
        const statusMap: Partial<Record<ModelProviderStatus, AIProviderHealth['status']>> = {
          CONNECTED: 'healthy', NOT_CONFIGURED: 'not_configured', OFFLINE: 'offline',
          ERROR: 'error', UNAVAILABLE: 'unavailable', RATE_LIMITED: 'rate_limited',
          QUOTA_EXCEEDED: 'quota_exceeded', NO_MODEL: 'model_missing',
        };
        const providers: Record<string, AIProviderHealth> = {};
        for (const provider of data.providers) {
          providers[provider.id] = {
            status: statusMap[provider.status] ?? 'error',
            model: provider.model,
            message: provider.error,
          };
        }
        const selected = this.selectedProvider === 'auto' ? undefined
          : data.providers.find(provider => provider.id === this.selectedProvider);
        const active = this.selectedProvider === 'auto'
          ? data.providers.find(provider => provider.status === 'CONNECTED')
          : selected?.status === 'CONNECTED' ? selected : undefined;
        if (this.selectedProvider !== 'auto' && !active) {
          return { status: selected?.status ?? 'NOT_CONFIGURED', error: selected?.error ?? 'Selected provider is unavailable.', providers };
        }
        const status = active ? 'CONNECTED'
          : data.status && data.status in statusMap ? data.status as ModelProviderStatus : 'ERROR';
        return { status, model: active?.model, error: active ? undefined : 'No connected provider reported by Nexus Hub.', providers };
      }
      if (this.selectedProvider !== 'auto') {
        return { status: 'UNAVAILABLE', error: 'Manual provider selection requires Hub 1.5 provider routing.' };
      }
      this.cpuFallbackReady = this.allowCpuFallback && data.ollamaCpuOnly === true && data.ollama?.status === 'healthy';
      const cloudHealth = data.cloud ?? data.gemini ?? data as AIProviderHealth;
      const health = cloudHealth.status !== 'healthy' && this.cpuFallbackReady && data.ollama ? data.ollama : cloudHealth;
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
      return { status, model: health.model, error: health.message, providers: data.providers };
    } catch {
      this.cpuFallbackReady = false;
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
        provider: this.selectedProvider === 'auto' ? undefined : this.selectedProvider,
        temperature: options.temperature,
        maxOutputTokens: options.maxOutputTokens ?? options.numPredict,
        mode: options.mode ?? 'AUTO',
        allowLocalFallback: this.allowLocalFallback || this.cpuFallbackReady,
      }),
      signal: options.signal instanceof AbortSignal ? options.signal : AbortSignal.timeout(90000),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Nexus AI bridge failed (HTTP ${response.status})`);
    }
    const result = await response.json() as { text?: string; provider?: string; providerId?: string };
    if (typeof result.text !== 'string' || !result.text) throw new Error('Nexus AI bridge returned an empty response.');
    this.lastProvider = result.provider ?? result.providerId ?? 'Nexus Hub';
    return result.text;
  }
}
