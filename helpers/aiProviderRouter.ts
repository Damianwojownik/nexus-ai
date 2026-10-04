import { nexusFreeMode, freeProviderBlock } from './freeMode.ts';

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
export type AIProviderCostClass = 'free-local' | 'free' | 'included' | 'paid';
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
  readonly cost?: number;
  readonly requiresCredits?: boolean;
  readonly requiresSubscription?: boolean;
  readonly routingTier?: number;
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
  private readonly freeOnly: boolean;
  private readonly healthCache = new Map<string, { until: number; health: AIProviderHealth }>();
  private readonly healthPending = new Map<string, Promise<AIProviderHealth>>();
  private readonly responseCache = new Map<string, { until: number; value: AIRoutedResponse }>();
  private readonly latency = new Map<string, number>();
  private readonly healthTtlMs: number;
  private readonly responseTtlMs: number;
  private readonly now: () => number;

  constructor(
    providers: AIProvider[],
    onProviderEvent: (event: AIProviderEvent) => void = (event) => console.info('[nexus:provider]', event),
    options: { freeOnly?: boolean; freeMode?: boolean; healthTtlMs?: number; responseTtlMs?: number; now?: () => number } = {},
  ) {
    this.providers = [...providers].sort((left, right) => right.priority - left.priority);
    this.onProviderEvent = onProviderEvent;
    this.freeOnly = options.freeMode ?? options.freeOnly ?? nexusFreeMode();
    this.healthTtlMs = options.healthTtlMs ?? 5000;
    this.responseTtlMs = options.responseTtlMs ?? 30000;
    this.now = options.now ?? Date.now;
    if (![this.healthTtlMs, this.responseTtlMs].every(value => Number.isFinite(value) && value >= 0)) {
      throw new Error('Cache TTL must be finite and nonnegative');
    }
  }

  inventory() {
    return this.providers.map(provider => ({
      id: provider.id, name: provider.name, local: provider.isLocal,
      cost: provider.cost ?? (provider.costClass === 'free-local' ? 0 : null),
      costClass: provider.costClass,
      blocked: this.freeOnly ? freeProviderBlock(provider) ?? null : null,
      latencyMs: this.latency.get(provider.id) ?? null,
    }));
  }

  private async providerHealth(provider: AIProvider): Promise<AIProviderHealth> {
    const blocked = this.freeOnly ? freeProviderBlock(provider) : undefined;
    if (blocked) return { status: 'not_configured', message: `FREE MODE: ${blocked}` };
    const cached = this.healthCache.get(provider.id);
    if (cached && cached.until > this.now()) return cached.health;
    const pending = this.healthPending.get(provider.id);
    if (pending) return pending;
    const task = (async () => {
      let health: AIProviderHealth;
      try { health = await provider.healthCheck(); }
      catch (error) { health = { status: 'error', message: error instanceof Error ? error.message : 'Health check failed' }; }
      this.healthCache.set(provider.id, { until: this.now() + this.healthTtlMs, health });
      return health;
    })();
    this.healthPending.set(provider.id, task);
    try { return await task; }
    finally { this.healthPending.delete(provider.id); }
  }

  private recordLatency(providerId: string, elapsed: number): void {
    const previous = this.latency.get(providerId);
    this.latency.set(providerId, previous === undefined ? elapsed : previous * 0.7 + elapsed * 0.3);
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
        return [provider.id, await this.providerHealth(provider)] as const;
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
    options: AIProviderGenerationOptions & { mode?: AIRoutingMode; allowLocalFallback?: boolean } = {},
  ): Promise<AIRoutedResponse> {
    const attempts: AIProviderAttempt[] = [];
    throwIfAborted(options.signal);
    const candidates = this.getCandidates(options.mode ?? 'AUTO', options.allowLocalFallback);
    const cacheKey = JSON.stringify([prompt, options.temperature, options.maxOutputTokens, candidates.map(provider => provider.id)]);
    const cached = this.responseCache.get(cacheKey);
    const cacheable = options.temperature === 0;
    if (cacheable && cached && cached.until > this.now()) {
      return { ...cached.value, attempts: cached.value.attempts.map(attempt => ({ ...attempt, health: { ...attempt.health } })) };
    }

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
        health = await this.providerHealth(provider);
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
        const started = this.now();
        const text = await provider.generate(prompt, options);
        throwIfAborted(options.signal);
        if (!text.trim()) throw new AIProviderRequestError('Empty provider response', 'unavailable');
        this.recordLatency(provider.id, this.now() - started);
        this.failures.delete(provider.id);
        if (attempts.slice(0, -1).some((item) => item.health.status !== 'healthy' || item.error) && provider.isLocal) {
          this.onProviderEvent({ type: 'fallback_selected', providerId: provider.id });
        }
        this.onProviderEvent({ type: 'success', providerId: provider.id });
        const result = { text, providerId: provider.id, attempts };
        if (cacheable && this.responseTtlMs > 0) {
          this.responseCache.delete(cacheKey);
          if (this.responseCache.size >= 64) {
            const oldest = this.responseCache.keys().next().value;
            if (oldest !== undefined) this.responseCache.delete(oldest);
          }
          this.responseCache.set(cacheKey, { until: this.now() + this.responseTtlMs, value: result });
        }
        return result;
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
    options: AIProviderGenerationOptions & { mode?: AIRoutingMode; allowLocalFallback?: boolean } = {},
  ): Promise<{ providerId: string; attempts: AIProviderAttempt[] }> {
    const attempts: AIProviderAttempt[] = [];
    const candidates = this.getCandidates(options.mode ?? 'AUTO', options.allowLocalFallback);

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
        health = await this.providerHealth(provider);
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
      const started = this.now();
      let timedFirstChunk = false;
      try {
        if (provider.stream) {
          await provider.stream(prompt, (chunk) => {
            throwIfAborted(options.signal);
            if (chunk.length && !timedFirstChunk) {
              this.recordLatency(provider.id, this.now() - started);
              timedFirstChunk = true;
            }
            emitted = emitted || chunk.length > 0;
            onChunk(chunk);
          }, options);
        } else {
          const text = await provider.generate(prompt, options);
          if (text) {
            emitted = true;
            onChunk(text);
          }
          throwIfAborted(options.signal);
          if (!emitted) throw new AIProviderRequestError('Empty provider stream', 'unavailable');
          if (!timedFirstChunk) this.recordLatency(provider.id, this.now() - started);
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

  private getCandidates(mode: AIRoutingMode, allowLocalFallback = true): AIProvider[] {
    if (this.freeOnly) return this.providers.filter(provider => !freeProviderBlock(provider) && (mode !== 'LOCAL' || provider.isLocal))
      .sort((a, b) => (a.routingTier ?? (a.isLocal ? 1 : 4)) - (b.routingTier ?? (b.isLocal ? 1 : 4))
        || (this.latency.get(a.id) ?? Number.POSITIVE_INFINITY) - (this.latency.get(b.id) ?? Number.POSITIVE_INFINITY)
        || b.priority - a.priority);
    if (!allowLocalFallback) return mode === 'LOCAL' ? [] : this.providers.filter((provider) => !provider.isLocal);
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
    this.healthCache.delete(providerId);
  }
}
