import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHub } from './agentHub.ts';
import { createAgentHubServer } from './agentHubServer.ts';

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

test('Agent Hub proxies health and binary generation from Nexus Image Engine', { timeout: 15000 }, async () => {
  const token = 'test-image-token';
  const fakePng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const imageServer = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        provider: 'test-image-provider',
        model: 'test-flux',
        mode: 'text-to-image',
        device: 'test-gpu',
        loaded: true,
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/generate') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw) as { prompt: string; width?: number; height?: number; steps?: number };
      assert.equal(body.prompt, 'A seated woman');
      assert.equal(body.width, 768);
      assert.equal(body.height, 1024);
      assert.equal(body.steps, 4);
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': fakePng.length,
        'X-Nexus-Model': 'test-flux',
        'X-Nexus-Seed': '123',
        'X-Nexus-Steps': '4',
      });
      response.end(fakePng);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const imageBaseUrl = await listen(imageServer);

  const previousUrl = process.env.NEXUS_IMAGE_SERVER_URL;
  const previousToken = process.env.NEXUS_IMAGE_SERVER_TOKEN;
  process.env.NEXUS_IMAGE_SERVER_URL = imageBaseUrl;
  process.env.NEXUS_IMAGE_SERVER_TOKEN = token;

  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-image-hub-'));
  const hub = new AgentHub({ stateFilePath: join(tempDir, 'hub-state.json') });
  const hubServer = createAgentHubServer(hub);
  const hubBaseUrl = await listen(hubServer);

  try {
    const health = await fetch(`${hubBaseUrl}/api/image/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json() as { ok: boolean; model?: string };
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.model, 'test-flux');

    const generated = await fetch(`${hubBaseUrl}/api/image/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'A seated woman', width: 768, height: 1024, steps: 4 }),
    });
    assert.equal(generated.status, 200);
    assert.equal(generated.headers.get('content-type'), 'image/png');
    assert.equal(generated.headers.get('x-nexus-model'), 'test-flux');
    assert.equal(generated.headers.get('x-nexus-seed'), '123');
    assert.deepEqual(Buffer.from(await generated.arrayBuffer()), fakePng);
  } finally {
    hubServer.closeAllConnections();
    imageServer.closeAllConnections();
    await new Promise<void>((resolve) => hubServer.close(() => resolve()));
    await new Promise<void>((resolve) => imageServer.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
    if (previousUrl === undefined) delete process.env.NEXUS_IMAGE_SERVER_URL;
    else process.env.NEXUS_IMAGE_SERVER_URL = previousUrl;
    if (previousToken === undefined) delete process.env.NEXUS_IMAGE_SERVER_TOKEN;
    else process.env.NEXUS_IMAGE_SERVER_TOKEN = previousToken;
  }
});
