import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

async function startMock(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}

async function unusedPort() {
  const { server, port } = await startMock((_req, res) => res.end());
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('mobile gateway requires pairing and safely proxies private Hub + Ollama', { timeout: 25_000 }, async t => {
  let backendCookie;
  const hub = await startMock((req, res) => {
    backendCookie = req.headers.cookie;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  const ollama = await startMock((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'qwen2.5:1.5b' }], path: req.url }));
  });
  t.after(async () => {
    await new Promise(resolve => hub.server.close(resolve));
    await new Promise(resolve => ollama.server.close(resolve));
  });

  const port = await unusedPort();
  const child = spawn(process.execPath, ['scripts/mobile-server.mjs'], {
    env: { ...process.env, NEXUS_MOBILE_PORT: String(port),
      NEXUS_AGENT_HUB_PORT: String(hub.port), OLLAMA_BASE_URL: 'http://127.0.0.1:' + ollama.port },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let output = '';
  let errors = '';
  child.stderr.on('data', chunk => { errors += String(chunk); });
  const code = await Promise.race([
    new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => {
        output += String(chunk);
        const match = output.match(/Kod parowania telefonu: ([\w-]+)/);
        if (match) resolve(match[1]);
      });
      child.on('exit', status => reject(new Error('Gateway exited ' + status + ': ' + errors)));
    }),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Gateway startup timeout: ' + errors)), 8_000)),
  ]);
  const base = 'http://127.0.0.1:' + port;

  const loginPage = await fetch(base + '/');
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /Kod parowania/);

  const noAuth = await fetch(base + '/api/health', { method: 'POST' });
  assert.equal(noAuth.status, 401);

  const badOrigin = await fetch(base + '/api/health', {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(badOrigin.status, 403);

  const wrongCode = await fetch(base + '/_pair', {
    method: 'POST', body: 'code=wrong', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(wrongCode.status, 401);

  const pair = await fetch(base + '/_pair', {
    method: 'POST', body: 'code=' + encodeURIComponent(code),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
  });
  assert.equal(pair.status, 303);
  const cookie = pair.headers.get('set-cookie')?.split(';')[0];
  assert.match(cookie || '', /^luna_mobile=[0-9a-f]{64}$/);

  const hubResult = await fetch(base + '/api/health', { headers: { Cookie: cookie } });
  assert.equal(hubResult.status, 200);
  assert.deepEqual(await hubResult.json(), { ok: true, path: '/api/health' });
  assert.equal(backendCookie, undefined, 'Auth cookie must never be forwarded to hub');

  const ollamaResult = await fetch(base + '/ollama/api/tags', { headers: { Cookie: cookie } });
  assert.equal(ollamaResult.status, 200);
  const json = await ollamaResult.json();
  assert.equal(json.path, '/api/tags');
  assert.equal(json.models[0].name, 'qwen2.5:1.5b');

  const blockedOllamaPath = await fetch(base + '/ollama/api/delete', { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(blockedOllamaPath.status, 405);

  const app = await fetch(base + '/', { headers: { Cookie: cookie } });
  assert.equal(app.status, 200);
  assert.match(await app.text(), /Luna Nexus/);
});
