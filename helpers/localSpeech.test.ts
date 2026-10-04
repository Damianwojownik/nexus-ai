import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSpeechText, validateSpeechWave } from './localSpeech.ts';
import { AgentHub } from './agentHub.ts';
import { createAgentHubServer } from './agentHubServer.ts';

test('local speech validates text size and WAV format', () => {
  assert.equal(validateSpeechText('  Cześć! '), 'Cześć!');
  for (const invalid of ['', ' ', 42, 'a'.repeat(6001)]) assert.throws(() => validateSpeechText(invalid));
  assert.throws(() => validateSpeechWave(Buffer.from('not audio')));
  const audio = Buffer.alloc(44);
  audio.write('RIFF');
  audio.write('WAVE', 8);
  assert.equal(validateSpeechWave(audio), audio);
});

test('speech API rejects invalid input and non-local browser origins', async () => {
  const server = createAgentHubServer(new AgentHub());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    for (const text of ['', 'x'.repeat(6001), 42]) {
      const result = await fetch(`${base}/api/speech/synthesize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
      assert.equal(result.status, 400);
    }
    const denied = await fetch(`${base}/api/speech/health`, { headers: { Origin: 'https://example.com' } });
    assert.equal(denied.status, 403);
    const health = await fetch(`${base}/api/speech/health`, { headers: { Origin: 'http://127.0.0.1:5173' } });
    assert.equal(health.status, 200);
    assert.equal(typeof (await health.json()).available, 'boolean');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
