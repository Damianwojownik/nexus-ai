import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProxyProvider } from './geminiProxyProvider.ts';

test('proxy supports Hub 1.5 provider array and direct ChatGPT without enabling local fallback', async () => {
  const originalFetch = globalThis.fetch;
  let connected = true;
  let localFallback: unknown;
  let requestedProvider: unknown;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') {
      localFallback = JSON.parse(String(init.body)).allowLocalFallback;
      requestedProvider = JSON.parse(String(init.body)).provider;
      return Response.json({ text: 'GPT reply', provider: 'ChatGPT plan' });
    }
    return Response.json({ status: connected ? 'CONNECTED' : 'OFFLINE', providers: [
      { id: 'chatgpt-plan', status: connected ? 'CONNECTED' : 'NOT_CONFIGURED', model: 'gpt-6-astra' },
      { id: 'gemini', status: 'NOT_CONFIGURED' },
    ] });
  };
  try {
    const proxy = new GeminiProxyProvider('http://127.0.0.1:8788', false, true, false);
    const health = await proxy.checkHealth();
    assert.equal(health.status, 'CONNECTED');
    assert.equal(health.model, 'gpt-6-astra');
    assert.equal(health.providers?.['chatgpt-plan'].status, 'healthy');
    assert.equal(await proxy.generate('test'), 'GPT reply');
    assert.equal(localFallback, false);
    proxy.selectProvider('copilot');
    assert.equal((await proxy.checkHealth()).status, 'NOT_CONFIGURED');
    proxy.selectProvider('chatgpt-plan');
    assert.equal((await proxy.checkHealth()).status, 'CONNECTED');
    await proxy.generate('manual');
    assert.equal(requestedProvider, 'chatgpt-plan');
    assert.equal(proxy.lastProvider, 'ChatGPT plan');
    proxy.selectProvider('auto');
    connected = false;
    assert.equal((await proxy.checkHealth()).status, 'OFFLINE');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('explicit provider failure is surfaced without retrying another provider', async () => {
  const originalFetch = globalThis.fetch;
  const requests: unknown[] = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)).provider);
    return Response.json({ error: 'Ollama unavailable' }, { status: 503 });
  };
  try {
    const proxy = new GeminiProxyProvider('http://127.0.0.1:8788', false, false, false);
    proxy.selectProvider('ollama');
    await assert.rejects(proxy.generate('test'), /Ollama unavailable/);
    assert.deepEqual(requests, ['ollama']);
    assert.equal(proxy.lastProvider, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('proxy recognizes cloud CLI and permits only explicitly confirmed CPU fallback', async () => {
  const originalFetch = globalThis.fetch;
  let cpuOnly = false;
  let cloudReady = true;
  let httpFailure = false;
  let allowLocal: unknown;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') {
      allowLocal = JSON.parse(String(init.body)).allowLocalFallback;
      return Response.json({ text: 'real provider reply' });
    }
    if (httpFailure) return new Response('', { status: 503 });
    return Response.json({
      cloud: { status: cloudReady ? 'healthy' : 'not_configured' },
      gemini: { status: 'not_configured' },
      ollama: { status: 'healthy', model: 'qwen' },
      ollamaCpuOnly: cpuOnly,
    });
  };
  try {
    const proxy = new GeminiProxyProvider('http://127.0.0.1:8788', false, true, false);
    assert.equal((await proxy.checkHealth()).status, 'CONNECTED');
    await proxy.generate('hello');
    assert.equal(allowLocal, false);
    cpuOnly = true;
    cloudReady = false;
    assert.equal((await proxy.checkHealth()).status, 'CONNECTED');
    await proxy.generate('hello');
    assert.equal(allowLocal, true);
    httpFailure = true;
    assert.equal((await proxy.checkHealth()).status, 'ERROR');
    await proxy.generate('hello');
    assert.equal(allowLocal, false);
    httpFailure = false;
    const strict = new GeminiProxyProvider('http://127.0.0.1:8788', false, false, false);
    assert.equal((await strict.checkHealth()).status, 'NOT_CONFIGURED');
    await strict.generate('hello');
    assert.equal(allowLocal, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
