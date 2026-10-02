export type AIProviderHealthStatus =
  | 'healthy'
  | 'unavailable'
  | 'unauthenticated'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'offline'
  | 'model_missing'
  | 'not_configured'
  | 'error';
export type AIProviderCostClass = 'free-local' | 'included' | 'paid';
export type AIRoutingMode = 'AUTO' | 'LOCAL' | 'CLOUD';
export type AIProviderEventType = 'provider_attempt' | 'provider_failed' | 'fallback_selected' | 'success';

export interface AIProviderEvent {
  type: AIProviderEventType;
  providerId: string;
  reason?: AIProviderHealthStatus | 'generation_failed';
}

export class AIProviderRequestError extends Error {
  readonly status: AIProviderHealthStatus;

  constructor(
    message: string,
    status: AIProviderHealthStatus,
  ) {
    super(message);
    this.name = 'AIProviderRequestError';
    this.status = status;
  }
}

export interface AIProviderHealth {
  status: AIProviderHealthStatus;
  model?: string;
  message?: string;
}

export interface AIProviderGenerationOptions {
  signal?: AbortSignal;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface AIProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly priority: number;
  readonly costClass: AIProviderCostClass;
  readonly isLocal: boolean;
  healthCheck(): Promise<AIProviderHealth>;
  generate(prompt: string, options?: AIProviderGenerationOptions): Promise<string>;
  stream?(
    prompt: string,
    onChunk: (chunk: string) => void,
    options?: AIProviderGenerationOptions,
  ): Promise<void>;
}

export interface AIProviderAttempt {
  providerId: string;
  health: AIProviderHealth;
  error?: string;
}

export interface AIRoutedResponse {
  text: string;
  providerId: string;
  attempts: AIProviderAttempt[];
}

export class AIProviderUnavailableError extends Error {
  readonly attempts: AIProviderAttempt[];

  constructor(attempts: AIProviderAttempt[]) {
    const details = attempts.map(({ providerId, health, error }) =>
      `${providerId}: ${health.status}${error ? ` (${error})` : ''}`).join('; ');
    super(details ? `No AI provider completed the request. ${details}` : 'No AI provider is registered.');
    this.name = 'AIProviderUnavailableError';
    this.attempts = attempts;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof Error && error.name === 'AbortError');
}

export class AIProviderRouter {
  private readonly providers: AIProvider[];
  private readonly failures = new Map<string, { count: number; cooldownUntil: number }>();
  private readonly cooldownMs = 30000;
  private readonly rateLimitCooldownMs = 60000;
  private readonly quotaCooldownMs = 15 * 60 * 1000;
  private readonly onProviderEvent: (event: AIProviderEvent) => void;

  constructor(
    providers: AIProvider[],
    onProviderEvent: (event: AIProviderEvent) => void = (event) => console.info('[nexus:provider]', event),
  ) {
    this.providers = [...providers].sort((left, right) => right.priority - left.priority);
    this.onProviderEvent = onProviderEvent;
  }

  async healthCheck(): Promise<Record<string, AIProviderHealth>> {
    const entries = await Promise.all(this.providers.map(async (provider) => {
      const circuit = this.failures.get(provider.id);
      if (circuit && circuit.cooldownUntil > Date.now()) {
        return [provider.id, {
          status: 'unavailable',
          message: 'Provider is cooling down after a recent failure.',
        } satisfies AIProviderHealth] as const;
      }
      try {
        return [provider.id, await provider.healthCheck()] as const;
      } catch (error) {
        return [provider.id, {
          status: 'error',
          message: error instanceof Error ? error.message : 'Health check failed',
        } satisfies AIProviderHealth] as const;
      }
    }));
    return Object.fromEntries(entries);
  }

  async generate(
    prompt: string,
    options: AIProviderGenerationOptions & { mode?: AIRoutingMode } = {},
  ): Promise<AIRoutedResponse> {
    const attempts: AIProviderAttempt[] = [];
    const candidates = this.getCandidates(options.mode ?? 'AUTO');

    for (const provider of candidates) {
      throwIfAborted(options.signal);
      const circuit = this.failures.get(provider.id);
      if (circuit && circuit.cooldownUntil > Date.now()) {
        attempts.push({
          providerId: provider.id,
          health: { status: 'unavailable', message: 'Provider is cooling down after a recent failure.' },
        });
        continue;
      }
      let health: AIProviderHealth;
      try {
        health = await provider.healthCheck();
      } catch (error) {
        health = { status: 'error', message: error instanceof Error ? error.message : 'Health check failed' };
      }
      const attempt: AIProviderAttempt = { providerId: provider.id, health };
      attempts.push(attempt);
      this.onProviderEvent({ type: 'provider_attempt', providerId: provider.id, reason: health.status });
      if (health.status !== 'healthy') {
        this.recordFailure(provider.id, health.status);
        this.onProviderEvent({ type: 'provider_failed', providerId: provider.id, reason: health.status });
        continue;
      }

      try {
        const text = await provider.generate(prompt, options);
        this.failures.delete(provider.id);
        if (attempts.slice(0, -1).some((item) => item.health.status !== 'healthy' || item.error) && provider.isLocal) {
          this.onProviderEvent({ type: 'fallback_selected', providerId: provider.id });
        }
        this.onProviderEvent({ type: 'success', providerId: provider.id });
        return { text, providerId: provider.id, attempts };
      } catch (error) {
        if (isAbortError(error, options.signal)) throw error;
        const status = error instanceof AIProviderRequestError ? error.status : 'unavailable';
        attempt.error = status;
        this.recordFailure(provider.id, status);
        this.onProviderEvent({ type: 'provider_failed', providerId: provider.id, reason: status });
      }
    }

    throw new AIProviderUnavailableError(attempts);
  }

  async stream(
    prompt: string,
    onChunk: (chunk: string) => void,
    options: AIProviderGenerationOptions & { mode?: AIRoutingMode } = {},
  ): Promise<{ providerId: string; attempts: AIProviderAttempt[] }> {
    const attempts: AIProviderAttempt[] = [];
    const candidates = this.getCandidates(options.mode ?? 'AUTO');

    for (const provider of candidates) {
      throwIfAborted(options.signal);
      const circuit = this.failures.get(provider.id);
      if (circuit && circuit.cooldownUntil > Date.now()) {
        attempts.push({
          providerId: provider.id,
          health: { status: 'unavailable', message: 'Provider is cooling down after a recent failure.' },
        });
        continue;
      }
      let health: AIProviderHealth;
      try {
        health = await provider.healthCheck();
      } catch (error) {
        health = { status: 'error', message: error instanceof Error ? error.message : 'Health check failed' };
      }
      const attempt: AIProviderAttempt = { providerId: provider.id, health };
      attempts.push(attempt);
      this.onProviderEvent({ type: 'provider_attempt', providerId: provider.id, reason: health.status });
      if (health.status !== 'healthy') {
        this.recordFailure(provider.id, health.status);
        this.onProviderEvent({ type: 'provider_failed', providerId: provider.id, reason: health.status });
        continue;
      }

      let emitted = false;
      try {
        if (provider.stream) {
          await provider.stream(prompt, (chunk) => {
            emitted = emitted || chunk.length > 0;
            onChunk(chunk);
          }, options);
        } else {
          const text = await provider.generate(prompt, options);
          if (text) {
            emitted = true;
            onChunk(text);
          }
        }
        this.failures.delete(provider.id);
        if (attempts.slice(0, -1).some((item) => item.health.status !== 'healthy' || item.error) && provider.isLocal) {
          this.onProviderEvent({ type: 'fallback_selected', providerId: provider.id });
        }
        this.onProviderEvent({ type: 'success', providerId: provider.id });
        return { providerId: provider.id, attempts };
      } catch (error) {
        if (isAbortError(error, options.signal)) throw error;
        const status = error instanceof AIProviderRequestError ? error.status : 'unavailable';
        attempt.error = status;
        this.recordFailure(provider.id, status);
        this.onProviderEvent({ type: 'provider_failed', providerId: provider.id, reason: status });
        if (emitted) throw new AIProviderUnavailableError(attempts);
      }
    }

    throw new AIProviderUnavailableError(attempts);
  }

  private getCandidates(mode: AIRoutingMode): AIProvider[] {
    if (mode === 'LOCAL') return this.providers.filter((provider) => provider.isLocal);
    if (mode === 'CLOUD') {
      return [
        ...this.providers.filter((provider) => !provider.isLocal),
        ...this.providers.filter((provider) => provider.isLocal),
      ];
    }
    return this.providers;
  }

  private recordFailure(providerId: string, status: AIProviderHealthStatus): void {
    const previous = this.failures.get(providerId);
    const count = (previous?.count ?? 0) + 1;
    const cooldownMs = status === 'rate_limited'
      ? this.rateLimitCooldownMs
      : status === 'quota_exceeded'
        ? this.quotaCooldownMs
        : count >= 2 ? this.cooldownMs : 0;
    this.failures.set(providerId, { count, cooldownUntil: Date.now() + cooldownMs });
  }
}
