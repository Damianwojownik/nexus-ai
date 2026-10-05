import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentHub } from './agentHub.ts';
import { createAgentHubServer } from './agentHubServer.ts';
import { parsePaulinaSpeechEvent } from './paulinaSpeechStream.ts';

test('native speech endpoints retain local-origin and input protections', async () => {
  const server = createAgentHubServer(new AgentHub());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of ['/api/speech/stream/health', '/api/speech/stream']) {
      const response = await fetch(base + path, {
        method: path.endsWith('health') ? 'GET' : 'POST',
        headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
        body: path.endsWith('health') ? undefined : JSON.stringify({ text: 'Cześć' }),
      });
      assert.equal(response.status, 403);
    }
    for (const text of ['', 42, 'x'.repeat(6001)]) {
      const response = await fetch(base + '/api/speech/stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
      assert.equal(response.status, 400);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('real local HTTP endpoint streams original Paulina PCM and native timing', { skip: process.platform !== 'win32' }, async t => {
  const server = createAgentHubServer(new AgentHub());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const healthResponse = await fetch(base + '/api/speech/stream/health', { headers: { Origin: 'http://127.0.0.1:5173' } });
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    if (!health.available) { t.skip(`Local Paulina unavailable: ${health.reason}`); return; }
    assert.equal(health.voice, 'Microsoft Paulina Desktop');
    assert.equal(health.device, 'cpu');
    assert.equal(health.cost, 0);
    const response = await fetch(base + '/api/speech/stream', {
      method: 'POST', headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Cześć! Miło cię widzieć.' }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /application\/x-ndjson/);
    const packets = (await response.text()).trim().split('\n').map(parsePaulinaSpeechEvent);
    assert.equal(packets[0].type, 'start');
    assert.equal(packets.at(-1)?.type, 'end');
    assert.ok(packets.some(packet => packet.type === 'phoneme'));
    assert.ok(packets.some(packet => packet.type === 'viseme'));
    let samples = 0, sequence = 0;
    for (const packet of packets) if (packet.type === 'audio') {
      assert.equal(packet.sequence, sequence++);
      assert.equal(packet.startSample, samples);
      samples += packet.sampleCount;
    }
    const final = packets.at(-1);
    assert(final?.type === 'end');
    assert.equal(final.totalSamples, samples);
    assert.ok(final.firstPcmMs < 1000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
