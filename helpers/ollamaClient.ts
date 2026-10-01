export type OllamaHealthStatus = 'CONNECTED' | 'OFFLINE' | 'NO_MODEL' | 'ERROR';

export type OllamaModel = {
  name: string;
  size?: number;
  modified_at?: string;
};

export type OllamaGenerateOptions = {
  model?: string;
  prompt: string;
  stream?: boolean;
  system?: string;
  context?: number[];
  signal?: AbortSignal;
  timeoutMs?: number;
  numPredict?: number;
};

export type OllamaHealthResult = {
  status: OllamaHealthStatus;
  baseUrl: string;
  model?: string;
  error?: string;
  models?: OllamaModel[];
};

const buildEnv = import.meta.env;
const processEnv = typeof process !== 'undefined' ? process.env : undefined;

const envBaseUrl = buildEnv?.VITE_OLLAMA_BASE_URL || processEnv?.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';

const envModel = buildEnv?.VITE_OLLAMA_MODEL || processEnv?.OLLAMA_MODEL || 'llama3.1';
const envTimeout = Number(buildEnv?.VITE_OLLAMA_TIMEOUT_MS || processEnv?.OLLAMA_TIMEOUT_MS || 30000);

export class OllamaClient {
  public baseUrl: string;
  public defaultModel: string;
  public timeoutMs: number;

  constructor(baseUrl = envBaseUrl, defaultModel = envModel, timeoutMs = envTimeout) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.defaultModel = defaultModel;
    this.timeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 30000;
  }

  async checkHealth(modelOverride?: string): Promise<OllamaHealthResult> {
    const model = modelOverride || this.defaultModel;
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return { status: 'OFFLINE', baseUrl: this.baseUrl, model, error: `Ollama returned HTTP ${response.status}` };
      }

      const data = await response.json();
      const models: OllamaModel[] = Array.isArray(data?.models) ? data.models : [];

      if (!models.length) {
        return { status: 'NO_MODEL', baseUrl: this.baseUrl, model, models };
      }

      const exists = models.some((m) => m.name === model || m.name.startsWith(`${model}:`));
      if (!exists) {
        return { status: 'NO_MODEL', baseUrl: this.baseUrl, model, models };
      }

      return { status: 'CONNECTED', baseUrl: this.baseUrl, model, models };
    } catch (error: any) {
      const message = error?.message || 'Unable to reach Ollama';
      return { status: 'OFFLINE', baseUrl: this.baseUrl, model, error: message };
    }
  }

  async listModels(): Promise<OllamaModel[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data?.models) ? data.models : [];
    } catch {
      return [];
    }
  }

  async generate(options: OllamaGenerateOptions): Promise<string> {
    const { prompt, model = this.defaultModel, stream = false, system, signal, timeoutMs = this.timeoutMs, numPredict } = options;

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream, system, options: { temperature: 0.2, ...(numPredict ? { num_predict: numPredict } : {}) } }),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: HTTP ${response.status}`);
    }

    const data = await response.json();
    return data?.response ?? '';
  }

  async streamGenerate(
    options: OllamaGenerateOptions,
    onChunk: (chunk: string) => void,
    onDone?: () => void,
    onError?: (error: Error) => void,
  ): Promise<void> {
    const { prompt, model = this.defaultModel, system, signal, timeoutMs = this.timeoutMs } = options;

    const controller = new AbortController();
    const combinedSignal = signal ? (AbortSignal.any ? AbortSignal.any([signal, controller.signal]) : controller.signal) : controller.signal;

    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: true, system, options: { temperature: 0.2 } }),
        signal: combinedSignal,
      });

      if (!response.ok) {
        throw new Error(`Ollama request failed: HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Readable stream is not available from Ollama.');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const raw of lines) {
          if (!raw.trim()) continue;
          try {
            const parsed = JSON.parse(raw);
            const chunk = parsed?.response ?? '';
            if (chunk) onChunk(chunk);
          } catch {
            // ignore partial JSON chunking during stream
          }
        }
      }

      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer);
          const chunk = parsed?.response ?? '';
          if (chunk) onChunk(chunk);
        } catch {
          // ignore trailing fragment
        }
      }

      onDone?.();
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        onDone?.();
        return;
      }
      onError?.(error as Error);
      throw error;
    }
  }
}

export const defaultOllamaClient = new OllamaClient();
export const DEFAULT_OLLAMA_MODEL = envModel;
