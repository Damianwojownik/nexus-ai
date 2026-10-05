import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentHubLiveAvatarClient, encodeLiveAudioPacket } from './neuralLiveAvatarProvider.ts';
import { characterProfile } from './characterProfiles.ts';

test('the browser live client only accepts a local credential-free Agent Hub URL', () => {
  assert.doesNotThrow(() => new AgentHubLiveAvatarClient('http://127.0.0.1:8788'));
  for (const url of ['https://example.com', 'http://example.com', 'http://user:pass@localhost:8788', 'http://localhost:8788/?token=x']) {
    assert.throws(() => new AgentHubLiveAvatarClient(url), /local credential-free Agent Hub/);
  }
});

test('Agent Hub client validates health, WebRTC sessions and SDP answers before returning them', async () => {
  const replies = [
    { available: true, status: 'AVAILABLE', mode: 'persistent-neural-stream', warm: true },
    {
      sessionId: 'session_1', controlUrl: 'wss://renderer.example/live/session_1/control',
      iceServers: [{ urls: 'stun:stun.example:3478' }],
    },
    { type: 'answer', sdp: 'v=0\r\n' },
    { closed: true },
  ];
  const calls: Array<{ url: string; method: string }> = [];
  const client = new AgentHubLiveAvatarClient('http://localhost:8788', async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' });
    return new Response(JSON.stringify(replies.shift()), { status: 200 });
  });

  const health = await client.health();
  assert.equal(health.available, true);
  const identity = characterProfile('nexus-librarian').identity;
  const session = await client.createSession(identity);
  assert.equal(session.sessionId, 'session_1');
  assert.deepEqual(session.iceServers, [{ urls: 'stun:stun.example:3478' }]);
  const answer = await client.exchangeOffer(session.sessionId, 'v=0\r\n');
  assert.deepEqual(answer, { type: 'answer', sdp: 'v=0\r\n' });
  await client.closeSession(session.sessionId);
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST', 'POST', 'DELETE']);
  assert.match(calls[1].url, /\/api\/avatar\/live\/sessions$/);
  assert.match(calls[2].url, /\/sessions\/session_1\/offer$/);
});

test('Agent Hub live client fails explicitly for malformed negotiation responses', async () => {
  const client = new AgentHubLiveAvatarClient('http://127.0.0.1:8788', async () =>
    new Response(JSON.stringify({ type: 'offer', sdp: '' }), { status: 200 }));
  await assert.rejects(client.exchangeOffer('session_1', 'v=0\r\n'), /malformed live WebRTC answer/);
});

test('audio packet preserves PCM16 bytes and the playback-clock presentation timestamp', () => {
  const pcm = Uint8Array.of(1, 0, 2, 0);
  const packet = encodeLiveAudioPacket({ streamId: 'stream_1', sequence: 3, pcm16: pcm, ptsMs: 120.5 });
  const view = new DataView(packet);
  const headerLength = view.getUint32(0, false);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(packet, 4, headerLength))) as Record<string, unknown>;
  assert.deepEqual(header, {
    type: 'AUDIO', streamId: 'stream_1', sequence: 3, ptsMs: 120.5,
    encoding: 'PCM16LE', sampleRate: 16000, channels: 1, byteLength: 4,
  });
  assert.deepEqual(new Uint8Array(packet, 4 + headerLength), pcm);
  assert.throws(() => encodeLiveAudioPacket({ streamId: 'stream_1', sequence: 3, pcm16: Uint8Array.of(1), ptsMs: 0 }), /complete samples/);
});
