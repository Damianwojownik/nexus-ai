import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { assertFreeConversationWorker, conversationAudio } from './conversationSpeech.ts';
import { AgentHub } from './agentHub.ts';
import { createAgentHubServer } from './agentHubServer.ts';
import { requestConversationVideo } from './avatarStudio.ts';

function wave(seconds = 1): Buffer {
  const data = Buffer.alloc(44 + seconds * 32000, 1);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  return data;
}

test('conversation WAV keeps full audio and validates format/duration before upload', () => {
  const audio = wave();
  assert.equal(conversationAudio(audio).durationSeconds, 1);
  assert.match(conversationAudio(audio).sha256, /^[a-f0-9]{64}$/);
  for (const invalid of [wave(31), wave().subarray(0, 100), Buffer.alloc(44)]) {
    assert.throws(() => conversationAudio(invalid));
  }
  audio.writeUInt32LE(44100, 24);
  assert.throws(() => conversationAudio(audio), /16000/);
});

test('conversation worker cost must be explicitly zero and preserve supplied audio', () => {
  const ready = { ok: true, engine: 'echomimic-v3', suppliedAudio: true, cost: 0 };
  assertFreeConversationWorker(ready);
  for (const invalid of [null, {}, { ...ready, cost: 1 }, { ...ready, cost: undefined },
    { ...ready, suppliedAudio: false }, { ...ready, ok: false }, { ...ready, engine: 'other' }]) {
    assert.throws(() => assertFreeConversationWorker(invalid), /zero-cost/);
  }
});

test('conversation browser sends current answer with consent and waits for the matching video', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    if (++calls === 1) {
      assert.deepEqual(JSON.parse(String(init?.body)), { text: 'Aktualna odpowiedź', cloudConsent: true });
      return Response.json({ jobId: id }, { status: 202 });
    }
    return Response.json({ status: 'complete', videoUrl: `/api/avatar/video/${id}` });
  };
  const options = { signal: new AbortController().signal, onProgress: () => {}, fetcher };
  await assert.rejects(requestConversationVideo('http://127.0.0.1:8788', 'Hello', false, options), /zgodę/);
  assert.equal(calls, 0);
  assert.equal(await requestConversationVideo('http://127.0.0.1:8788', 'Aktualna odpowiedź', true, options),
    `http://127.0.0.1:8788/api/avatar/video/${id}`);
});

test('FREE conversation blocks unconfirmed worker before speech synthesis or network render', async () => {
  const original = process.env.NEXUS_AVATAR_FREE_CONFIRMED;
  delete process.env.NEXUS_AVATAR_FREE_CONFIRMED;
  const server = createAgentHubServer(new AgentHub());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/api/avatar/conversation`;
    for (const [cloudConsent, status] of [[false, 400], [true, 403]] as const) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello', cloudConsent }) });
      assert.equal(response.status, status);
      assert.ok((await response.json()).error);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (original === undefined) delete process.env.NEXUS_AVATAR_FREE_CONFIRMED;
    else process.env.NEXUS_AVATAR_FREE_CONFIRMED = original;
  }
});
