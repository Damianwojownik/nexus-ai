import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiAIProvider } from './geminiAIProvider.ts';
import { AIProviderRouter } from './aiProviderRouter.ts';
import type { AIProvider } from './aiProviderRouter.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { AgentHub } from './agentHub.ts';
import { createAgentHubServer } from './agentHubServer.ts';

test('FREE Gemini rejects unverified keys and moving aliases before any network call', async () => {
  for (const options of [
    { freeTierConfirmed: false },
    { freeTierConfirmed: true, model: 'gemini-flash-latest' },
    { freeTierConfirmed: true, model: 'unverified-model' },
  ]) {
    const provider = new GeminiAIProvider({
      ...options, apiKey: 'synthetic-test-key', primary: true,
      fetcher: async () => { assert.fail('Blocked Gemini attempted network'); },
    });
    assert.equal((await provider.healthCheck()).status, 'not_configured');
    await assert.rejects(provider.generate('test'), /FREE/);
    await assert.rejects(provider.stream('test', () => {}), /FREE/);
    assert.equal(provider.costClass, 'paid');
    assert.equal(provider.routingTier, 4);
  }
});

test('confirmed Gemini uses server-only header and correct standard/SSE endpoints', async () => {
  const urls: string[] = [];
  const provider = new GeminiAIProvider({
    apiKey: 'synthetic-test-key', freeTierConfirmed: true, primary: true,
    fetcher: async (input, init) => {
      const url = String(input);
      urls.push(url);
      assert.ok(!url.includes('synthetic-test-key'));
      assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'synthetic-test-key');
      assert.equal(init?.redirect, 'error');
      if (!init?.method) return Response.json({ name: 'gemini-2.5-flash' });
      assert.equal(JSON.parse(String(init.body)).contents[0].parts[0].text, 'hello');
      if (url.includes('streamGenerateContent')) {
        return new Response('data: {"candidates":[{"content":{"parts":[{"text":"Luna"}]}}]}\n\n');
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: 'Luna' }] } }] });
    },
  });
  assert.equal((await provider.healthCheck()).status, 'healthy');
  assert.equal(await provider.generate('hello'), 'Luna');
  const chunks: string[] = [];
  await provider.stream('hello', chunk => chunks.push(chunk));
  assert.deepEqual(chunks, ['Luna']);
  assert.equal(provider.cost, 0);
  assert.equal(provider.routingTier, 0);
  assert.ok(urls[1].endsWith('/gemini-2.5-flash:generateContent'));
  assert.ok(urls[2].endsWith('/gemini-2.5-flash:streamGenerateContent?alt=sse'));
  assert.ok(!urls.some(url => url.includes(':generateContent:streamGenerateContent')));
});

test('Gemini-first FREE routing falls back locally on quota without calling a paid provider', async () => {
  let exhausted = false;
  const gemini = new GeminiAIProvider({
    apiKey: 'synthetic-test-key', freeTierConfirmed: true, primary: true,
    fetcher: async (_input, init) => {
      if (!init?.method) return Response.json({});
      if (exhausted) return new Response('', { status: 429 });
      return Response.json({ candidates: [{ content: { parts: [{ text: 'Gemini reply' }] } }] });
    },
  });

  const local: AIProvider = {
    id: 'ollama-local', name: 'Ollama', capabilities: ['ai.chat'],
    priority: 200, routingTier: 1, cost: 0, costClass: 'free-local', isLocal: true,
    async healthCheck() { return { status: 'healthy' }; },
    async generate() { return 'local reply'; },
  };
  const paid: AIProvider = {
    ...local, id: 'paid', isLocal: false, costClass: 'paid', cost: 1, routingTier: -1,
    async healthCheck() { assert.fail('Paid health called'); },
    async generate() { assert.fail('Paid generation called'); },
  };
  const router = new AIProviderRouter([local, gemini, paid], () => {}, { freeMode: true });
  assert.equal((await router.generate('first')).providerId, 'google-gemini');
  exhausted = true;
  assert.equal((await router.generate('second')).providerId, 'ollama-local');
  assert.equal((await router.generate('third')).providerId, 'ollama-local');
});

test('actual Hub routes generate and SSE through confirmed primary Gemini without exposing credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-test-'));
    const secret = 'synthetic-private-test-key';
    const gemini = new GeminiAIProvider({
      apiKey: secret, freeTierConfirmed: true, primary: true,
      fetcher: async (input, init) => {
        if (!init?.method) return Response.json({});
        const payload = { candidates: [{ content: { parts: [{ text: 'Jestem Luna.' }] } }] };
        return String(input).includes('streamGenerateContent')
          ? new Response(`data: ${JSON.stringify(payload)}\n\n`)
          : Response.json(payload);
      },
    });
    const router = new AIProviderRouter([gemini], () => {}, { freeMode: true });
    const server = createAgentHubServer(new AgentHub({ stateFilePath: join(root, 'hub.json') }),
      { aiRouter: router, freeOnly: true, workspaceDir: join(root, 'workspace') });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try {
      const base = `http://127.0.0.1:${address.port}`;
      const health = await fetch(`${base}/api/ai/health`).then(r => r.text());
      assert.ok(!health.includes(secret));
      assert.equal(JSON.parse(health).freeOnly, true);
      for (const endpoint of ['generate', 'stream']) {
        const response = await fetch(`${base}/api/ai/${endpoint}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'hello' }),
        });
        assert.equal(response.status, 200);
        const body = await response.text();
        assert.ok(!body.includes(secret));
        assert.match(body, /google-gemini/);
        assert.match(body, /Jestem Luna/);
        if (endpoint === 'stream') assert.match(body, /event: complete/);
      }
    } finally {
      const closed = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await closed;
      await rm(root, { recursive: true, force: true });
    }
});
