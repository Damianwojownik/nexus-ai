import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PcmBackpressureError, PcmStreamPlayer } from './pcmStream.ts';
import type { PcmChunk, PcmPlaybackBackend } from './pcmStream.ts';

class Backend implements PcmPlaybackBackend {
  time = 0;
  scheduled: { samples: Float32Array; when: number; ended: () => void; stopped: boolean }[] = [];
  nowSeconds() { return this.time; }
  async resume() {}
  schedule(samples: Float32Array, _rate: number, when: number, ended: () => void) {
    const item = { samples, when, ended, stopped: false };
    this.scheduled.push(item);
    return { stop: () => { item.stopped = true; } };
  }
}

function chunk(sequence: number, durationMs = 100): PcmChunk {
  const pcm16 = new Uint8Array(durationMs * 16 * 2);
  const view = new DataView(pcm16.buffer);
  view.setInt16(0, -32768, true);
  view.setInt16(2, 32767, true);
  return { sequence, pcm16, sampleRate: 16000, sha256: createHash('sha256').update(pcm16).digest('hex') };
}

test('PCM is hashed, decoded and scheduled before the full utterance is known', async () => {
  const backend = new Backend();
  const player = new PcmStreamPlayer(backend, { streamId: 'turn-1' });
  const proof = await player.enqueue(chunk(0));
  assert.equal(player.durationMs, undefined);
  assert.equal(proof.startMs, 0);
  assert.equal(proof.durationMs, 100);
  assert.equal(backend.scheduled[0].samples[0], -1);
  assert.ok(backend.scheduled[0].samples[1] < 1);
  assert.equal(backend.scheduled[0].when, 0.06);
  backend.time = 0.11;
  assert.ok(Math.abs(player.positionMs() - 50) < 0.001);
  await player.enqueue(chunk(1));
  assert.equal(backend.scheduled[1].when, 0.16);
  player.seal();
  assert.equal(player.durationMs, 200);
  assert.equal(player.chunkProof(1)?.startMs, 100);
});

test('underrun freezes logical audio time instead of advancing mouth timing into silence', async () => {
  const backend = new Backend();
  const player = new PcmStreamPlayer(backend, { streamId: 'turn-2' });
  await player.enqueue(chunk(0));
  backend.time = 0.5;
  backend.scheduled[0].ended();
  assert.equal(player.positionMs(), 100);
  await player.enqueue(chunk(1));
  assert.equal(backend.scheduled[1].when, 0.56);
  backend.time = 0.61;
  assert.ok(Math.abs(player.positionMs() - 150) < 0.001);
});

test('invalid input does not replace scheduled audio or consume sequence numbers', async () => {
  const backend = new Backend();
  const player = new PcmStreamPlayer(backend, { streamId: 'turn-3' });
  await assert.rejects(player.enqueue({ ...chunk(0), sha256: 'a'.repeat(64) }), /digest mismatch/);
  await assert.rejects(player.enqueue(chunk(1)), /out of order/);
  await assert.rejects(player.enqueue({ ...chunk(0), sampleRate: 24000 }), /sample rate mismatch/);
  await assert.rejects(player.enqueue({ ...chunk(0), pcm16: new Uint8Array(3) }), /complete/);
  assert.equal(backend.scheduled.length, 0);
  await player.enqueue(chunk(0));
  assert.equal(backend.scheduled.length, 1);
});

test('bounded buffer exposes backpressure and can retry the same packet after playback', async () => {
  const backend = new Backend();
  const player = new PcmStreamPlayer(backend, { streamId: 'turn-4', maxBufferedMs: 200, maxChunkMs: 100 });
  await player.enqueue(chunk(0));
  await player.enqueue(chunk(1));
  await assert.rejects(player.enqueue(chunk(2)), PcmBackpressureError);
  backend.time = 0.16;
  await player.enqueue(chunk(2));
  assert.equal(backend.scheduled.length, 3);
});

test('cancellation blocks a digest that finishes later and stops owned scheduled sources', async () => {
  const backend = new Backend();
  let finish!: (value: string) => void;
  const player = new PcmStreamPlayer(backend, {
    streamId: 'turn-5', digest: () => new Promise<string>(resolve => { finish = resolve; }),
  });
  const packet = chunk(0);
  const pending = player.enqueue(packet);
  player.stop();
  finish(packet.sha256);
  await assert.rejects(pending, /cancelled/);
  assert.equal(backend.scheduled.length, 0);
  const second = new PcmStreamPlayer(backend, { streamId: 'turn-6' });
  await second.enqueue(packet);
  second.stop();
  assert.equal(backend.scheduled[0].stopped, true);
});

test('ended is emitted only after sealing and all PCM sources complete', async () => {
  const backend = new Backend();
  const player = new PcmStreamPlayer(backend, { streamId: 'turn-7' });
  let ended = 0;
  player.onEnded(() => ended++);
  await player.enqueue(chunk(0));
  backend.time = 0.16;
  backend.scheduled[0].ended();
  assert.equal(ended, 0);
  player.seal();
  assert.equal(ended, 1);
  assert.equal(player.positionMs(), 100);
  await assert.rejects(player.enqueue(chunk(1)), /no longer accepting/);
});

test('a regressing clock is refused and scheduler failures are observable', async () => {
  const backend = new Backend();
  const errors: Error[] = [];
  const player = new PcmStreamPlayer(backend, { streamId: 'turn-8', onError: error => errors.push(error) });
  await player.enqueue(chunk(0));
  backend.time = 0.1;
  player.positionMs();
  backend.time = 0.05;
  assert.throws(() => player.positionMs(), /monotonic/);
  const failing: PcmPlaybackBackend = {
    nowSeconds: () => 0, resume: async () => {},
    schedule: () => { throw new Error('audio device lost'); },
  };
  const broken = new PcmStreamPlayer(failing, { streamId: 'turn-9', onError: error => errors.push(error) });
  await assert.rejects(broken.enqueue(chunk(0)), /audio device lost/);
  assert.equal(errors[0].message, 'audio device lost');
  assert.throws(() => broken.positionMs(), /audio device lost/);
  player.stop();
  assert.equal(backend.scheduled[0].stopped, true);
});
