export type AIModelMode = 'LOCAL' | 'AUTO' | 'CLOUD';
export type ProviderRole = 'PRIMARY_ORCHESTRATOR' | 'SUBAGENT';
export type ModelProviderStatus =
  | 'CONNECTED'
  | 'OFFLINE'
  | 'NO_MODEL'
  | 'NOT_CONFIGURED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'UNAVAILABLE'
  | 'ERROR';
export type ProviderFailureReason = ModelProviderStatus | 'generation_failed';

export interface ProviderFallbackEvent {
  type: 'provider_attempt' | 'provider_failed' | 'fallback_selected' | 'success';
  providerId: string;
  reason?: ProviderFailureReason;
}

export interface ModelProvider {
  readonly name: string;
  readonly mode: AIModelMode;
  readonly role: ProviderRole;
  readonly id?: string;
  readonly capabilities?: readonly string[];
  readonly priority?: number;
  readonly costClass?: 'free' | 'free-local' | 'metered' | 'included' | 'paid';
  readonly local?: boolean;
  generate(prompt: string, options?: Record<string, any>): Promise<string>;
  checkHealth(): Promise<{ status: ModelProviderStatus; model?: string; error?: string; models?: any[] }>;
  listModels(): Promise<any[]>;
}

export class OllamaProvider implements ModelProvider {
  readonly name = 'Ollama';
  readonly mode: AIModelMode = 'LOCAL';
  readonly role: ProviderRole = 'SUBAGENT';

  private client: any;

  constructor(client: any) {
    this.client = client;
  }

  async checkHealth() {
    return this.client.checkHealth();
  }

  async listModels() {
    return this.client.listModels();
  }

  async generate(prompt: string, options: Record<string, any> = {}) {
    return this.client.generate({ ...options, prompt });
  }
}

export class ModelRouter {
  private providers: ModelProvider[];
  private preferredMode: AIModelMode;
  private primaryProvider?: ModelProvider;
  private readonly onProviderEvent: (event: ProviderFallbackEvent) => void;
  private readonly providerCooldowns = new Map<string, { failures: number; until: number }>();

  constructor(
    preferredMode: AIModelMode = 'AUTO',
    providers: ModelProvider[] = [],
    primaryProvider?: ModelProvider,
    onProviderEvent: (event: ProviderFallbackEvent) => void = (event) => {
      console.info('[nexus:provider]', event);
    },
  ) {
    this.preferredMode = preferredMode;
    this.providers = providers;
    this.primaryProvider = primaryProvider;
    this.onProviderEvent = onProviderEvent;
  }

  setPreferredMode(mode: AIModelMode) {
    this.preferredMode = mode;
  }

  setPrimaryProvider(provider?: ModelProvider) {
    this.primaryProvider = provider;
  }

  register(provider: ModelProvider) {
    if (this.providers.some((item) => item.id === provider.id && provider.id !== undefined)) {
      throw new Error(`Provider is already registered: ${provider.id}`);
    }
    this.providers.push(provider);
  }

  async route(prompt: string, options: Record<string, any> = {}) {
    const signal = options.signal instanceof AbortSignal ? options.signal : undefined;
    const localProviders = this.providers
      .filter((provider) => provider.local === true || provider.mode === 'LOCAL' || provider.role === 'SUBAGENT')
      .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
    const cloudProviders = this.providers
      .filter((provider) => !localProviders.includes(provider))
      .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
    const orderedCandidates = this.preferredMode === 'LOCAL'
      ? localProviders
      : [
        ...(this.primaryProvider ? [this.primaryProvider] : []),
        ...cloudProviders.filter((provider) => provider !== this.primaryProvider),
        ...localProviders,
      ];
    const candidates = [...new Set(orderedCandidates)];
    const attempts: Array<{ provider: ModelProvider; status?: ModelProviderStatus; failed: boolean }> = [];

    for (const provider of candidates) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
      const providerId = provider.id ?? provider.name;
      const cooldown = this.providerCooldowns.get(providerId);
      if (cooldown && cooldown.until > Date.now()) {
        attempts.push({ provider, status: 'UNAVAILABLE', failed: true });
        this.onProviderEvent({ type: 'provider_failed', providerId, reason: 'UNAVAILABLE' });
        continue;
      }
      let health: Awaited<ReturnType<ModelProvider['checkHealth']>>;
      try {
        health = await provider.checkHealth();
      } catch {
        health = { status: 'ERROR', error: 'Health check failed' };
      }
      attempts.push({ provider, status: health.status, failed: false });
      this.onProviderEvent({ type: 'provider_attempt', providerId, reason: health.status });
      if (health.status !== 'CONNECTED') {
        attempts[attempts.length - 1].failed = true;
        const reason = classifyProviderFailure(health.error, health.status);
        this.recordProviderFailure(providerId, reason);
        this.onProviderEvent({ type: 'provider_failed', providerId, reason });
        continue;
      }

      try {
        const response = await provider.generate(prompt, options);
        this.providerCooldowns.delete(providerId);
        if (attempts.some((attempt) => attempt.failed) && provider.local) {
          this.onProviderEvent({ type: 'fallback_selected', providerId });
        }
        this.onProviderEvent({ type: 'success', providerId });
        return response;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        const reason = classifyProviderFailure(error);
        attempts[attempts.length - 1].failed = true;
        this.recordProviderFailure(providerId, reason);
        this.onProviderEvent({ type: 'provider_failed', providerId, reason });
      }
    }

    const attemptedProviders = attempts.map(({ provider, status }) => {
      const label = provider.id ?? provider.name;
      return `${label}: ${status ?? 'generation_failed'}`;
    });
    throw new Error(attemptedProviders.length
      ? `No AI provider is available (${attemptedProviders.join('; ')}).`
      : this.preferredMode === 'LOCAL' ? 'Local provider is not registered.' : 'No AI provider is registered.');
  }

  private recordProviderFailure(providerId: string, reason: ProviderFailureReason): void {
    const previous = this.providerCooldowns.get(providerId);
    const failures = (previous?.failures ?? 0) + 1;
    const cooldownMs = reason === 'QUOTA_EXCEEDED'
      ? 15 * 60 * 1000
      : reason === 'RATE_LIMITED'
        ? 60 * 1000
        : failures >= 2 ? 30 * 1000 : 0;
    this.providerCooldowns.set(providerId, { failures, until: Date.now() + cooldownMs });
  }
}

function classifyProviderFailure(error: unknown, fallback: ProviderFailureReason = 'generation_failed'): ProviderFailureReason {
  const details = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const statusCode = details.statusCode ?? details.status;
  const message = [
    error instanceof Error ? error.message : typeof error === 'string' ? error : '',
    typeof details.code === 'string' ? details.code : '',
    typeof details.type === 'string' ? details.type : '',
  ].join(' ');
  if (statusCode === 402 || /quota|insufficient[_ -]?credits?|points?(?:\s+are)?\s+(?:exhausted|depleted)|(?:usage|premium request|copilot)[ _-]?(?:limit|quota)|premium requests?.{0,24}(?:exhausted|depleted)|used all.{0,24}premium requests?|billing limit/i.test(message)) {
    return 'QUOTA_EXCEEDED';
  }
  if (statusCode === 429 || /\b429\b|rate[_ -]?limit|too many requests/i.test(message)) return 'RATE_LIMITED';
  if (/timeout|timed out|unavailable|network|connection/i.test(message)) return 'UNAVAILABLE';
  return fallback;
}
