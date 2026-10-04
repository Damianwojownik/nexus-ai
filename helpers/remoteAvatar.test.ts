import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteAvatar } from './remoteAvatar.ts';
import { AgentHub } from './agentHub.ts';
import { createAgentHubServer } from './agentHubServer.ts';

test('Own cloud engine accepts portrait and text without a HeyGen key', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const id = '01234567-89ab-cdef-0123-456789abcdef';
  const request: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(calls.length === 1 ? { jobId: id } : { status: 'complete' });
  };
  const client = new RemoteAvatar('https://avatar.example', 'own-server-token', request);
  assert.equal(await client.generate(new Uint8Array([1, 2]), 'image/png', 'Hello'), id);
  assert.equal(calls[0].url, 'https://avatar.example/jobs');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { image: 'AQI=', mime: 'image/png', text: 'Hello' });
  assert.equal(new Headers(calls[0].init?.headers).get('Authorization'), 'Bearer own-server-token');
  assert.deepEqual(await client.result(id), { status: 'complete' });
  assert.equal(calls[1].url, `https://avatar.example/jobs/${id}`);
});

test('Remote errors never cause local rendering; insecure configuration is rejected', async () => {
  assert.throws(() => new RemoteAvatar('http://localhost:8000', 'token'), /HTTPS/);
  assert.throws(() => new RemoteAvatar('https://user:pass@avatar.example', 'token'), /HTTPS/);
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return new Response('', { status: 429 }); };
  await assert.rejects(new RemoteAvatar('https://avatar.example', 'token', request).generate(new Uint8Array([1]), 'image/png', 'Hello'), /HTTP 429/);
  assert.equal(calls, 1);
});

test('Avatar API disables local GPU and advertises the own cloud engine', async () => {
  const server = createAgentHubServer(new AgentHub());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const config = await (await fetch(`${base}/api/avatar/config`)).json() as { localRenderingEnabled: boolean; provider: string };
    assert.equal(config.localRenderingEnabled, false);
    assert.equal(config.provider, 'nexus-cloud');
    for (const provider of ['local', 'heygen']) {
      const response = await fetch(`${base}/api/avatar/animate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello', provider, cloudConsent: true }),
      });
      assert.equal(response.status, 400);
      assert.match(JSON.stringify(await response.json()), /GPU rendering is disabled/);
    }
    assert.equal((await fetch(`${base}/api/avatar/video/old-job`)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
