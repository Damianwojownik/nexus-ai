import type {
  AIProvider,
  AIProviderGenerationOptions,
  AIProviderHealth,
} from './aiProviderRouter.ts';
import { AIProviderRequestError } from './aiProviderRouter.ts';

interface OllamaTagsResponse {
  models?: Array<{ name: string; size?: number; modified_at?: string; remote_model?: string; remote_host?: string }>;
}

function localBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Ollama URL must use HTTP or HTTPS.');
  }
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error('Ollama must remain bound to a loopback address.');
  }
  return url.toString().replace(/\/$/, '');
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class OllamaHttpProvider implements AIProvider {
  readonly id = 'ollama-local';
  readonly name = 'Ollama';
  readonly capabilities = ['ai.chat', 'ai.code', 'ai.analyze', 'ai.stream', 'ai.offline'];
  readonly priority = 10;
  readonly costClass = 'free-local' as const;
  readonly isLocal = true;
  readonly cost = 0;
  readonly routingTier = 1;

  readonly baseUrl: string;
  private readonly configuredModel?: string;
  private detectedModel?: string;
  private verifiedModel?: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly numThreads?: number;
  private readonly keepAlive: string;
  readonly cpuOnly: boolean;

  get model(): string {
    return this.configuredModel ?? this.detectedModel ?? 'auto';
  }

  constructor(options: {
    baseUrl?: string;
    model?: string;
    fetcher?: typeof fetch;
    timeoutMs?: number;
    cpuOnly?: boolean;
    numThreads?: number;
    keepAlive?: string;
  } = {}) {
    this.baseUrl = localBaseUrl(options.baseUrl ?? process.env.NEXUS_OLLAMA_BASE_URL ?? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434');
    this.configuredModel = options.model ?? process.env.OLLAMA_MODEL;
    if (this.configuredModel && /(?:-cloud|:cloud)$/i.test(this.configuredModel)) {
      throw new Error('Ollama cloud models are not allowed by the local provider');
    }
    this.fetcher = options.fetcher ?? fetch;
    this.cpuOnly = options.cpuOnly ?? false;
    this.numThreads = options.numThreads ?? (process.env.OLLAMA_NUM_THREADS === undefined ? undefined : Number(process.env.OLLAMA_NUM_THREADS));
    if (this.numThreads !== undefined && (!Number.isInteger(this.numThreads) || this.numThreads < 1 || this.numThreads > 256)) {
      throw new Error('OLLAMA_NUM_THREADS must be an integer between 1 and 256.');
    }
    this.keepAlive = options.keepAlive ?? process.env.OLLAMA_KEEP_ALIVE ?? '15m';
    if (!/^\d+(?:s|m|h)$/.test(this.keepAlive)) throw new Error('OLLAMA_KEEP_ALIVE must be a duration such as 15m.');
    const configuredTimeout = options.timeoutMs ?? Number(process.env.OLLAMA_TIMEOUT_MS ?? 60000);
    this.timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 60000;
  }

  async healthCheck(): Promise<AIProviderHealth> {
    try {
      const response = await this.fetcher(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      if (!response.ok) return { status: 'offline', model: this.model, message: `Ollama returned HTTP ${response.status}` };
      const data = await response.json() as OllamaTagsResponse;
      const models = (data.models ?? []).filter(item => !item.remote_host && !item.remote_model && !/(?:-cloud|:cloud)$/i.test(item.name));
      if (!models.length) return { status: 'model_missing', message: 'No local Ollama models are installed.' };
      const lightweight = models.filter((item) => item.size === undefined || item.size <= 2_500_000_000);
      const available = lightweight.length ? lightweight : models;
      const preferred = ['qwen', 'gemma', 'mistral', 'llama'];
      const selected = this.configuredModel
        ? models.find((item) => item.name === this.configuredModel || item.name.startsWith(`${this.configuredModel}:`))
        : preferred.map((prefix) => available.find((item) => item.name.toLowerCase().startsWith(prefix))).find(Boolean) ?? available[0];
      if (!selected) {
        return { status: 'model_missing', model: this.model, message: `Configured Ollama model ${this.model} is not installed.` };
      }
      this.detectedModel = selected.name;
      this.verifiedModel = this.model;
      return { status: 'healthy', model: this.model };
    } catch {
      return { status: 'offline', model: this.model, message: 'Local Ollama is unreachable.' };
    }
  }

  async generate(prompt: string, options: AIProviderGenerationOptions = {}): Promise<string> {
    await this.ensureLocalModel();
    const response = await this.fetcher(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        keep_alive: this.keepAlive,
        options: {
          ...(this.cpuOnly ? { num_gpu: 0 } : {}),
          ...(this.numThreads !== undefined ? { num_thread: this.numThreads } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxOutputTokens !== undefined ? { num_predict: options.maxOutputTokens } : {}),
        },
      }),
      signal: combineSignal(options.signal, this.timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) {
      const status = response.status === 404 ? 'model_missing' : response.status >= 500 ? 'unavailable' : 'error';
      throw new AIProviderRequestError(`Ollama generation failed (HTTP ${response.status})`, status);
    }
    const payload = await response.json() as { response?: string };
    if (!payload.response) throw new AIProviderRequestError('Ollama returned an empty response.', 'unavailable');
    return payload.response;
  }

  async stream(
    prompt: string,
    onChunk: (chunk: string) => void,
    options: AIProviderGenerationOptions = {},
  ): Promise<void> {
    await this.ensureLocalModel();
    const response = await this.fetcher(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt, stream: true, keep_alive: this.keepAlive,
        options: { ...(this.cpuOnly ? { num_gpu: 0 } : {}),
          ...(this.numThreads !== undefined ? { num_thread: this.numThreads } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxOutputTokens !== undefined ? { num_predict: options.maxOutputTokens } : {}) },
      }),
      signal: combineSignal(options.signal, this.timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) {
      const status = response.status === 404 ? 'model_missing' : response.status >= 500 ? 'unavailable' : 'error';
      throw new AIProviderRequestError(`Ollama stream failed (HTTP ${response.status})`, status);
    }
    if (!response.body) throw new AIProviderRequestError('Ollama streaming response has no body.', 'unavailable');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let complete = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) complete = this.consumeLine(line, onChunk) || complete;
        if (done) break;
      }
      if (buffer.trim()) complete = this.consumeLine(buffer, onChunk) || complete;
      if (!complete) throw new AIProviderRequestError('Ollama stream ended before completion', 'unavailable');
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }

  private consumeLine(line: string, onChunk: (chunk: string) => void): boolean {
    if (!line.trim()) return false;
    const payload = JSON.parse(line) as { response?: string; error?: string; done?: boolean };
    if (payload.error) throw new AIProviderRequestError('Ollama stream failed', 'unavailable');
    if (payload.response) onChunk(payload.response);
    return payload.done === true;
  }

  private async ensureLocalModel(): Promise<void> {
    if (this.verifiedModel === this.model) return;
    const health = await this.healthCheck();
    if (health.status !== 'healthy') throw new AIProviderRequestError(health.message ?? 'Local model unavailable', health.status);
  }
}
