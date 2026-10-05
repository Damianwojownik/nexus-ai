import { AIProviderRequestError } from './aiProviderRouter.ts';
import type { AIProvider, AIProviderGenerationOptions, AIProviderHealth } from './aiProviderRouter.ts';

export class LlamaCppProvider implements AIProvider {
  readonly id = 'llamacpp-local';
  readonly name = 'llama.cpp';
  readonly cost = 0;
  readonly costClass = 'free-local' as const;
  readonly isLocal = true;
  readonly routingTier = 2;
  readonly priority = 5;
  readonly capabilities = ['ai.chat', 'ai.code', 'ai.stream', 'ai.offline'];
  private readonly baseUrl?: string;
  private readonly fetcher: typeof fetch;
  private model = '';

  constructor(options: { baseUrl?: string; fetcher?: typeof fetch } = {}) {
    const value = options.baseUrl ?? process.env.NEXUS_LLAMACPP_BASE_URL;
    if (value) {
      const url = new URL(value);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.search || url.hash) {
        throw new Error('llama.cpp must use credential-free loopback HTTP');
      }
      this.baseUrl = url.toString().replace(/\/$/, '');
    }
    this.fetcher = options.fetcher ?? fetch;
  }

  async healthCheck(): Promise<AIProviderHealth> {
    if (!this.baseUrl) return { status: 'not_configured', message: 'NEXUS_LLAMACPP_BASE_URL is not configured; no model downloads performed.' };
    try {
      const response = await this.fetcher(`${this.baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      if (!response.ok) return { status: 'offline', message: `llama.cpp HTTP ${response.status}` };
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || !('data' in value) || !Array.isArray(value.data)) {
        return { status: 'error', message: 'llama.cpp model response is invalid' };
      }
      const first: unknown = value.data[0];
      if (!first || typeof first !== 'object' || !('id' in first) || typeof first.id !== 'string' || !first.id) {
        return { status: 'model_missing', message: 'No model loaded in llama.cpp' };
      }
      this.model = first.id;
      return { status: 'healthy', model: this.model };
    } catch (error) {
      return { status: 'offline', message: error instanceof Error ? error.message : 'llama.cpp health failed' };
    }
  }

  private async request(prompt: string, streaming: boolean, options: AIProviderGenerationOptions): Promise<Response> {
    if (!this.baseUrl || !this.model) throw new AIProviderRequestError('llama.cpp has no loaded model', 'model_missing');
    const timeout = AbortSignal.timeout(60000);
    const response = await this.fetcher(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: prompt }],
        stream: streaming, temperature: options.temperature, max_tokens: options.maxOutputTokens }),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    if (!response.ok) throw new AIProviderRequestError(`llama.cpp HTTP ${response.status}`, 'unavailable');
    return response;
  }

  async generate(prompt: string, options: AIProviderGenerationOptions = {}): Promise<string> {
    const value = await (await this.request(prompt, false, options)).json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const text = value.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new AIProviderRequestError('llama.cpp returned empty text', 'unavailable');
    return text;
  }

  async stream(prompt: string, onChunk: (chunk: string) => void, options: AIProviderGenerationOptions = {}): Promise<void> {
    const response = await this.request(prompt, true, options);
    if (!response.body) throw new AIProviderRequestError('llama.cpp stream has no body', 'unavailable');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let complete = false;
    const consume = (line: string) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data) return;
      if (data === '[DONE]') { complete = true; return; }
      const value = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }>; error?: unknown };
      if (value.error) throw new AIProviderRequestError('llama.cpp stream error', 'unavailable');
      const text = value.choices?.[0]?.delta?.content;
      if (typeof text === 'string') onChunk(text);
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) { buffer += decoder.decode(); break; }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) consume(line.trimEnd());
      }
      if (buffer) consume(buffer.trimEnd());
      if (!complete) throw new AIProviderRequestError('llama.cpp stream ended before completion', 'unavailable');
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
}
