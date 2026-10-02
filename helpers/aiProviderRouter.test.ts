import test from 'node:test';
import assert from 'node:assert/strict';
import { AIProviderRouter, AIProviderRequestError } from './aiProviderRouter.ts';
import type {
  AIProvider,
  AIProviderGenerationOptions,
  AIProviderHealth,
} from './aiProviderRouter.ts';
import { GeminiAIProvider } from './geminiAIProvider.ts';
import { OllamaHttpProvider } from './ollamaHttpProvider.ts';
import { ModelRouter } from './modelRouter.ts';

function provider(overrides: Partial<AIProvider> & Pick<AIProvider, 'id' | 'isLocal'>): AIProvider {
  return {
    name: overrides.id,
    capabilities: ['ai.chat'],
    priority: overrides.isLocal ? 10 : 100,
    costClass: overrides.isLocal ? 'free-local' : 'paid',
    async healthCheck(): Promise<AIProviderHealth> { return { status: 'healthy' }; },
    async generate(): Promise<string> { return `${overrides.id} response`; },
    ...overrides,
  };
}

test('router falls back from a quota-limited cloud provider to local Ollama', async () => {
  const events: string[] = [];
  const cloud = provider({
    id: 'cloud',
    isLocal: false,
    async generate() { throw new AIProviderRequestError('quota reached', 'quota_exceeded'); },
  });
  const local = provider({ id: 'ollama', isLocal: true, async generate() { return 'local response'; } });
  const router = new AIProviderRouter([local, cloud], (event) => events.push(`${event.type}:${event.providerId}`));

  const result = await router.generate('hello');

  assert.equal(result.text, 'local response');
  assert.equal(result.providerId, 'ollama');
  assert.deepEqual(events, [
    'provider_attempt:cloud',
    'provider_failed:cloud',
    'provider_attempt:ollama',
    'fallback_selected:ollama',
    'success:ollama',
  ]);
});

test('router cools down a rate-limited provider and does not retry it immediately', async () => {
  let cloudCalls = 0;
  const cloud = provider({
    id: 'cloud',
    isLocal: false,
    async generate() {
      cloudCalls += 1;
      throw new AIProviderRequestError('rate limited', 'rate_limited');
    },
  });
  const router = new AIProviderRouter([cloud, provider({ id: 'ollama', isLocal: true })], () => {});

  assert.equal((await router.generate('first')).providerId, 'ollama');
  assert.equal((await router.generate('second')).providerId, 'ollama');
  assert.equal(cloudCalls, 1);
});

test('ModelRouter detects Copilot quota/points errors and immediately uses the free local model', async () => {
  let copilotCalls = 0;
  let localCalls = 0;
  const events: string[] = [];
  const copilot = {
    id: 'copilot-primary',
    name: 'Copilot bridge',
    mode: 'CLOUD' as const,
    role: 'PRIMARY_ORCHESTRATOR' as const,
    async checkHealth() { return { status: 'CONNECTED' as const }; },
    async listModels() { return []; },
    async generate() {
      copilotCalls += 1;
      throw new Error('Copilot premium requests exhausted; quota reached (HTTP 429)');
    },
  };
  const local = {
    id: 'ollama',
    name: 'Ollama',
    mode: 'LOCAL' as const,
    role: 'SUBAGENT' as const,
    local: true,
    async checkHealth() { return { status: 'CONNECTED' as const }; },
    async listModels() { return [{ name: 'qwen2.5:1.5b' }]; },
    async generate() {
      localCalls += 1;
      return 'free local response';
    },
  };
  const router = new ModelRouter('AUTO', [local], copilot, (event) => {
    events.push(`${event.type}:${event.providerId}:${event.reason ?? ''}`);
  });

  assert.equal(await router.route('first prompt'), 'free local response');
  assert.equal(await router.route('second prompt'), 'free local response');
  assert.equal(copilotCalls, 1);
  assert.equal(localCalls, 2);
  assert.ok(events.includes('provider_failed:copilot-primary:QUOTA_EXCEEDED'));
  assert.ok(events.includes('fallback_selected:ollama:'));
});

test('router propagates cancellation instead of silently falling back', async () => {
  let localCalls = 0;
  const controller = new AbortController();
  const cloud = provider({
    id: 'cloud',
    isLocal: false,
    async generate(_prompt: string, options?: AIProviderGenerationOptions) {
      controller.abort();
      throw options?.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError');
    },
  });
  const local = provider({
    id: 'ollama',
    isLocal: true,
    async generate() { localCalls += 1; return 'should not run'; },
  });
  const router = new AIProviderRouter([cloud, local], () => {});

  await assert.rejects(router.generate('cancel', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(localCalls, 0);
});

test('router does not switch providers after streaming has already emitted output', async () => {
  let localCalls = 0;
  const cloud = provider({
    id: 'cloud',
    isLocal: false,
    async stream(_prompt, onChunk) {
      onChunk('partial');
      throw new Error('stream interrupted');
    },
  });
  const local = provider({
    id: 'ollama',
    isLocal: true,
    async generate() { localCalls += 1; return 'duplicate response'; },
  });
  const router = new AIProviderRouter([cloud, local], () => {});
  const chunks: string[] = [];

  await assert.rejects(router.stream('hello', (chunk) => chunks.push(chunk)));
  assert.deepEqual(chunks, ['partial']);
  assert.equal(localCalls, 0);
});

test('Gemini provider classifies quota failures without exposing the API key', async () => {
  const secret = 'test-secret-never-in-error';
  const providerInstance = new GeminiAIProvider({
    apiKey: secret,
    fetcher: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('x-goog-api-key'), secret);
      return new Response('', { status: 429 });
    },
  });

  await assert.rejects(providerInstance.generate('hello'), (error: unknown) => {
    assert.ok(error instanceof AIProviderRequestError);
    assert.equal(error.status, 'rate_limited');
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test('Ollama selects an installed preferred model and refuses non-loopback URLs', async () => {
  let generatedModel = '';
  const ollama = new OllamaHttpProvider({
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) {
        return Response.json({ models: [{ name: 'custom:latest' }, { name: 'qwen2.5:1.5b' }] });
      }
      generatedModel = JSON.parse(String(init?.body)).model;
      return Response.json({ response: 'local reply' });
    },
  });

  assert.deepEqual(await ollama.healthCheck(), { status: 'healthy', model: 'qwen2.5:1.5b' });
  assert.equal(await ollama.generate('hello'), 'local reply');
  assert.equal(generatedModel, 'qwen2.5:1.5b');
  assert.throws(() => new OllamaHttpProvider({ baseUrl: 'http://example.com:11434' }), /loopback/);
});
