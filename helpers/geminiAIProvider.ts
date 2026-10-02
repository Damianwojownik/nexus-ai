import type {
  AIProvider,
  AIProviderGenerationOptions,
  AIProviderHealth,
} from './aiProviderRouter.ts';
import { AIProviderRequestError } from './aiProviderRouter.ts';

interface GeminiTextPart {
  text?: string;
}

interface GeminiGenerateResponse {
  candidates?: Array<{ content?: { parts?: GeminiTextPart[] } }>;
}

function errorMessage(status: number): string {
  if (status === 401 || status === 403) return `Gemini authorization failed (HTTP ${status})`;
  if (status === 402) return 'Gemini credits are exhausted (HTTP 402)';
  if (status === 429) return 'Gemini rate limit or quota reached (HTTP 429)';
  return `Gemini API request failed (HTTP ${status})`;
}

function healthStatus(status: number): AIProviderHealth['status'] {
  if (status === 401 || status === 403) return 'unauthenticated';
  if (status === 402) return 'quota_exceeded';
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'model_missing';
  if (status >= 500) return 'unavailable';
  return 'error';
}

function responseText(value: GeminiGenerateResponse): string {
  return value.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim() ?? '';
}

export class GeminiAIProvider implements AIProvider {
  readonly id = 'google-gemini';
  readonly name = 'Google Gemini';
  readonly capabilities = ['ai.chat', 'ai.code', 'ai.analyze', 'ai.stream'];
  readonly priority = 100;
  readonly costClass = 'paid' as const;
  readonly isLocal = false;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: {
    apiKey?: string;
    model?: string;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {}) {
    this.apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? '';
    this.model = options.model ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  async healthCheck(): Promise<AIProviderHealth> {
    if (!this.apiKey) return { status: 'not_configured', model: this.model, message: 'GEMINI_API_KEY is not configured.' };
    try {
      const response = await this.fetcher(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}`,
        { headers: { 'x-goog-api-key': this.apiKey }, signal: AbortSignal.timeout(this.timeoutMs) },
      );
      if (response.ok) return { status: 'healthy', model: this.model };
      return { status: healthStatus(response.status), model: this.model, message: errorMessage(response.status) };
    } catch {
      return { status: 'offline', model: this.model, message: 'Gemini API is unreachable.' };
    }
  }

  async generate(prompt: string, options: AIProviderGenerationOptions = {}): Promise<string> {
    this.requireKey();
    const response = await this.fetcher(this.generateUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
        },
      }),
      signal: options.signal ?? AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) throw new AIProviderRequestError(errorMessage(response.status), healthStatus(response.status));
    const payload = await response.json() as GeminiGenerateResponse;
    const text = responseText(payload);
    if (!text) throw new AIProviderRequestError('Gemini returned an empty text response.', 'unavailable');
    return text;
  }

  async stream(
    prompt: string,
    onChunk: (chunk: string) => void,
    options: AIProviderGenerationOptions = {},
  ): Promise<void> {
    this.requireKey();
    const response = await this.fetcher(`${this.generateUrl()}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
        },
      }),
      signal: options.signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new AIProviderRequestError(errorMessage(response.status), healthStatus(response.status));
    if (!response.body) throw new AIProviderRequestError('Gemini streaming response has no body.', 'unavailable');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) this.consumeSseLine(line, onChunk);
    }
    if (buffer.trim()) this.consumeSseLine(buffer, onChunk);
  }

  private generateUrl(): string {
    return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
  }

  private requireKey(): void {
    if (!this.apiKey) throw new Error('Gemini provider is not configured.');
  }

  private consumeSseLine(line: string, onChunk: (chunk: string) => void): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const chunk = responseText(JSON.parse(data) as GeminiGenerateResponse);
    if (chunk) onChunk(chunk);
  }
}
