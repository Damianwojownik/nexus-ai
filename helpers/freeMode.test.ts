import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { AIProviderRouter } from './aiProviderRouter.ts';
import type { AIProvider } from './aiProviderRouter.ts';
import { nexusFreeMode, freeProviderBlock } from './freeMode.ts';
import { createAgentHubServer } from './agentHubServer.ts';
import { AgentHub } from './agentHub.ts';
import { OllamaHttpProvider } from './ollamaHttpProvider.ts';
import { LlamaCppProvider } from './llamaCppProvider.ts';
import { GeminiAIProvider } from './geminiAIProvider.ts';
import { CloudCliProvider } from './cloudCliProvider.ts';
import { GeminiProxyProvider } from './geminiProxyProvider.ts';

function local(overrides: Partial<AIProvider> = {}): AIProvider {
  return { id: 'local', name: 'local', isLocal: true, costClass: 'free-local', cost: 0,
    priority: 10, routingTier: 1, capabilities: ['ai.chat'],
    async healthCheck() { return { status: 'healthy' }; },
    async generate() { return 'local response'; }, ...overrides };
}

function forbidden(overrides: Partial<AIProvider> = {}): AIProvider {
  return local({ id: 'paid', isLocal: false, costClass: 'paid', cost: 1,
    async healthCheck() { assert.fail('FREE MODE called paid health'); },
    async generate() { assert.fail('FREE MODE called paid generation'); },
    async stream() { assert.fail('FREE MODE called paid stream'); }, ...overrides });
}

test('FREE mode defaults on, parses strictly and blocks nonzero/unverified costs', () => {
  assert.equal(nexusFreeMode(undefined), true);
  assert.equal(nexusFreeMode('true'), true);
  assert.equal(nexusFreeMode('false'), false);
  assert.throws(() => nexusFreeMode('1'));
  for (const provider of [
    forbidden(), forbidden({ isLocal: true, costClass: 'free-local' }),
    forbidden({ costClass: 'free', cost: 0, requiresCredits: true }),
    forbidden({ costClass: 'free', cost: 0, requiresSubscription: true }),
    forbidden({ costClass: 'included', cost: 0 }),
    forbidden({ costClass: 'free', cost: undefined }),
    forbidden({ costClass: 'free', cost: NaN }),
  ]) assert.ok(freeProviderBlock(provider));
  assert.equal(freeProviderBlock(local()), undefined);
  assert.equal(freeProviderBlock(local({ isLocal: false, costClass: 'free' })), undefined);
});

test('FREE health, generation, streaming and forced selection never call paid providers', async () => {
  const router = new AIProviderRouter([forbidden(), forbidden({ id: 'false-local', isLocal: true }), local()], () => {}, { freeMode: true });
  assert.equal((await router.healthCheck()).paid.status, 'not_configured');
  assert.equal((await router.generate('hello')).providerId, 'local');
  const chunks: string[] = [];
  assert.equal((await router.stream('hello', chunk => chunks.push(chunk))).providerId, 'local');
  assert.deepEqual(chunks, ['local response']);
  await assert.rejects(router.generate('hello', { providerId: 'paid' }));
  await assert.rejects(router.stream('hello', () => {}, { providerId: 'paid' }));
  assert.match(router.inventory().find(item => item.id === 'paid')!.blocked!, /cost/);
});

test('FREE cannot silently fall back to paid providers when local inference fails', async () => {
  const router = new AIProviderRouter([forbidden(), local({ async generate() { throw new Error('offline'); } })], () => {}, { freeMode: true });
  await assert.rejects(router.generate('hello'), /No AI provider/);
  await assert.rejects(router.stream('hello', () => {}), /No AI provider/);
});

test('health TTL uses single-flight and refreshes after expiry', async () => {
  let now = 1, checks = 0;
  const router = new AIProviderRouter([local({ async healthCheck() { checks++; return { status: 'healthy' }; } })],
    () => {}, { freeMode: true, now: () => now, healthTtlMs: 100 });
  await Promise.all([router.healthCheck(), router.healthCheck(), router.generate('hello')]);
  assert.equal(checks, 1);
  now += 101;
  await router.healthCheck();
  assert.equal(checks, 2);
});

test('local deterministic response cache respects TTL, options and bounded size', async () => {
  let now = 1, calls = 0;
  const router = new AIProviderRouter([local({ async generate() { calls++; return `response ${calls}`; } })],
    () => {}, { freeMode: true, now: () => now, responseTtlMs: 100 });
  const first = await router.generate('hello', { temperature: 0 });
  assert.equal((await router.generate('hello', { temperature: 0 })).text, first.text);
  assert.equal(calls, 1);
  await router.generate('hello', { temperature: 0, maxOutputTokens: 5 });
  await router.generate('hello');
  await router.generate('hello');
  assert.equal(calls, 4);
  now += 101;
  await router.generate('hello', { temperature: 0 });
  assert.equal(calls, 5);
  for (let index = 0; index < 70; index++) await router.generate(String(index), { temperature: 0 });
  await router.generate('0', { temperature: 0 });
  assert.equal(calls, 76);
});

test('tier priority precedes latency and measured latency orders providers in one tier', async () => {
  let now = 0;
  const slow = local({ id: 'slow', priority: 1, async generate() { now += 40; return 'slow'; } });
  const fast = local({ id: 'fast', priority: 2, async generate() { now += 5; return 'fast'; } });
  const remote = local({ id: 'remote', isLocal: false, costClass: 'free', routingTier: 4, priority: 999 });
  const router = new AIProviderRouter([slow, fast, remote], () => {}, { freeMode: true, now: () => now });
  await router.generate('slow probe', { providerId: 'slow' });
  await router.generate('fast probe', { providerId: 'fast' });
  assert.equal((await router.generate('hello')).providerId, 'fast');
});

test('stream failure after tokens does not switch even to another free provider', async () => {
  const router = new AIProviderRouter([
    local({ id: 'first', priority: 20, async stream(_prompt, emit) { emit('partial'); throw new Error('lost stream'); } }),
    local({ id: 'second', async generate() { assert.fail('duplicate fallback output'); } }),
  ], () => {}, { freeMode: true });
  const chunks: string[] = [];
  await assert.rejects(router.stream('hello', chunk => chunks.push(chunk)), /No AI provider/);
  assert.deepEqual(chunks, ['partial']);
});

test('FREE server hardens an injected router and rejects paid generate/stream/OAuth selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-free-'));
  const router = new AIProviderRouter([forbidden(), local()], () => {}, { freeMode: false });
  const server = createAgentHubServer(new AgentHub({ stateFilePath: join(root, 'tasks.json') }),
    { workspaceDir: join(root, 'workspace'), aiRouter: router, freeOnly: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${base}/api/ai/health`).then(response => response.json());
    assert.equal(health.freeOnly, true);
    assert.equal(health.providers.paid.status, 'not_configured');
    for (const endpoint of ['generate', 'stream']) {
      const response = await fetch(`${base}/api/ai/${endpoint}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'test', provider: 'claude' }) });
      assert.equal(response.status, 403);
      const invalid = await fetch(`${base}/api/ai/${endpoint}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'test', temperature: -1 }) });
      assert.equal(invalid.status, 400);
    }
    assert.equal((await fetch(`${base}/api/chatgpt/sign-in/start`, { method: 'POST' })).status, 403);
    const response = await fetch(`${base}/api/ai/generate`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'test' }) });
    assert.equal((await response.json()).providerId, 'local');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('empty free streams are not reported as successful', async () => {
  const router = new AIProviderRouter([local({ async stream() {} })], () => {}, { freeMode: true });
  await assert.rejects(router.stream('test', () => {}), /No AI provider/);
});

test('failed local generation invalidates cached health', async () => {
  let checks = 0;
  const router = new AIProviderRouter([local({
    async healthCheck() { checks++; return { status: 'healthy' }; },
    async generate() { throw new Error('offline'); },
  })], () => {}, { freeMode: true });
  await router.healthCheck();
  await assert.rejects(router.generate('test'));
  await router.healthCheck();
  assert.equal(checks, 2);
});

test('aborted FREE generation cannot return a cached success', async () => {
  const router = new AIProviderRouter([local()], () => {}, { freeMode: true });
  await router.generate('test', { temperature: 0 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(router.generate('test', { temperature: 0, signal: controller.signal }), { name: 'AbortError' });
});

test('Ollama never selects cloud-tagged models or follows health redirects', async () => {
  const provider = new OllamaHttpProvider({ fetcher: async (_url, init) => {
    assert.equal(init?.redirect, 'error');
    return Response.json({ models: [{ name: 'gpt-oss:cloud' }] });
  } });
  assert.equal((await provider.healthCheck()).status, 'model_missing');
  assert.throws(() => new OllamaHttpProvider({ model: 'gpt-oss:cloud' }), /cloud/);
});

test('llama.cpp is loopback only, discovers installed model and streams locally', async () => {
  assert.throws(() => new LlamaCppProvider({ baseUrl: 'http://example.com' }), /loopback/);
  const provider = new LlamaCppProvider({ baseUrl: 'http://127.0.0.1:8080', fetcher: async (url, init) => {
    assert.equal(init?.redirect, 'error');
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'local-gguf' }] });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'local-gguf');
    return body.stream ? new Response('data: {"choices":[{"delta":{"content":"local"}}]}\n\ndata: [DONE]\n\n')
      : Response.json({ choices: [{ message: { content: 'local' } }] });
  } });
  assert.equal((await provider.healthCheck()).model, 'local-gguf');
  assert.equal(await provider.generate('test'), 'local');
  const chunks: string[] = [];
  await provider.stream('test', chunk => chunks.push(chunk));
  assert.deepEqual(chunks, ['local']);
});

test('cloud providers refuse direct invocation in default FREE mode before network/CLI', async () => {
  const previous = process.env.NEXUS_FREE_MODE;
  process.env.NEXUS_FREE_MODE = 'true';
  try {
    const gemini = new GeminiAIProvider({ apiKey: 'synthetic', fetcher: async () => { assert.fail('paid network'); } });
    await assert.rejects(gemini.generate('test'), /FREE/);
    const claude = new CloudCliProvider('claude');
    assert.equal((await claude.healthCheck()).status, 'not_configured');
    await assert.rejects(claude.generate('test'), /FREE/);
  } finally {
    if (previous === undefined) delete process.env.NEXUS_FREE_MODE;
    else process.env.NEXUS_FREE_MODE = previous;
  }
});

test('browser Hub proxy emits incremental SSE and rejects truncated streams', async () => {
  const original = globalThis.fetch;
  try {
    const health = () => Response.json({ freeOnly: true, providers: { local: { status: 'healthy' } } });
    globalThis.fetch = async url => String(url).endsWith('/health') ? health()
      : new Response('event: token\ndata: {"text":"hello"}\n\nevent: complete\ndata: {"providerId":"local"}\n\n');
    const proxy = new GeminiProxyProvider('http://127.0.0.1:8788');
    const chunks: string[] = [];
    assert.equal(await proxy.generate('test', { onToken: (chunk: string) => chunks.push(chunk) }), 'hello');
    assert.deepEqual(chunks, ['hello']);
    globalThis.fetch = async url => String(url).endsWith('/health') ? health()
      : new Response('event: token\ndata: {"text":"partial"}\n\n');
    await assert.rejects(proxy.generate('test', { onToken() {} }), /complete/);
  } finally { globalThis.fetch = original; }
});

test('browser refuses inference through an older or non-FREE Hub', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      if (init?.method === 'POST') assert.fail('Paid/non-FREE Hub inference attempted');
      return Response.json({ providers: [{ id: 'claude', status: 'CONNECTED' }] });
    };
    await assert.rejects(new GeminiProxyProvider('http://127.0.0.1:8788').generate('test'), /FREE MODE/);
  } finally { globalThis.fetch = original; }
});

test('Ollama rejects renamed cloud aliases before direct generation', async () => {
  const provider = new OllamaHttpProvider({ model: 'innocent-local-name', fetcher: async url => {
    if (!String(url).endsWith('/api/tags')) assert.fail('Cloud alias generation attempted');
    return Response.json({ models: [{ name: 'innocent-local-name', remote_model: 'paid-model', remote_host: 'https://ollama.com' }] });
  } });
  await assert.rejects(provider.generate('test'), /local Ollama models/);
});

test('explicit NEXUS_FREE_MODE=true cannot be weakened by router options', async () => {
  const previous = process.env.NEXUS_FREE_MODE;
  process.env.NEXUS_FREE_MODE = 'true';
  try {
    const router = new AIProviderRouter([forbidden()], () => {}, { freeMode: false });
    await assert.rejects(router.generate('test'));
    assert.ok(router.inventory()[0].blocked);
  } finally {
    if (previous === undefined) delete process.env.NEXUS_FREE_MODE;
    else process.env.NEXUS_FREE_MODE = previous;
  }
});
