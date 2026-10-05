import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { REST_MOUTH } from './characterEngine.ts';
import type { CharacterTimeline } from './characterEngine.ts';
import { CharacterStreamSession } from './characterStream.ts';
import type { StreamingCharacterRenderer } from './characterStream.ts';
import type { CharacterSessionFrame, FrameScheduler } from './characterSession.ts';
import { PcmStreamPlayer } from './pcmStream.ts';
import type { PcmPlaybackBackend } from './pcmStream.ts';

const identity = { id: 'bear', revision: '1', referenceSha256: 'a'.repeat(64), rigRevision: 'test-rig' };
const bytes = new Uint8Array(3200);
const digest = createHash('sha256').update(bytes).digest('hex');
const timeline = (overrides: Partial<CharacterTimeline> = {}): CharacterTimeline => ({
  identity: { ...identity }, audioSha256: digest, durationMs: 100, language: 'pl', timingSource: 'tts-phonemes',
  cues: [{ phoneme: 'a', startMs: 0, endMs: 100, pose: { ...REST_MOUTH, jaw: 0.8 } }], ...overrides,
});

class Scheduler implements FrameScheduler {
  callbacks: (() => void)[] = [];
  request(callback: () => void) { this.callbacks.push(callback); return callback; }
  cancel() {}
  tick() { const callbacks = this.callbacks.splice(0); for (const callback of callbacks) callback(); }
}

class Backend implements PcmPlaybackBackend {
  time = 0;
  stops = 0;
  nowSeconds() { return this.time; }
  async resume() {}
  schedule() { return { stop: () => this.stops++ }; }
}

function rig(): StreamingCharacterRenderer & { frames: CharacterSessionFrame[] } {
  const frames: CharacterSessionFrame[] = [];
  return {
    id: 'test', mode: 'articulatory-rig', frames,
    capabilities: { rigRevision: identity.rigRevision, referenceSha256: identity.referenceSha256, channels: ['jaw', 'width', 'rounding', 'lipClosure'] },
    render: frame => frames.push(frame),
  };
}

function setup() {
  const backend = new Backend();
  const clock = new PcmStreamPlayer(backend, { streamId: 'turn-1' });
  const renderer = rig();
  const scheduler = new Scheduler();
  const session = new CharacterStreamSession(identity, renderer, scheduler);
  const playback = session.begin(clock);
  const enqueue = (sequence: number) => clock.enqueue({ sequence, sampleRate: 16000, pcm16: bytes, sha256: digest });
  return { backend, clock, renderer, scheduler, session, playback, enqueue };
}

test('first PCM is animated before the full reply exists and clock controls all frames', async () => {
  const { backend, clock, renderer, scheduler, playback, enqueue } = setup();
  await enqueue(0);
  playback.append(0, timeline());
  backend.time = 0.11;
  scheduler.tick();
  assert.equal(clock.durationMs, undefined);
  assert.equal(playback.status(), 'playing');
  assert.ok(Math.abs(renderer.frames.at(-1)!.audioMs - 50) < 0.001);
  assert.equal(renderer.frames.at(-1)?.mouth.jaw, 0.8);
  await enqueue(1);
  playback.append(1, timeline());
  playback.seal();
  clock.seal();
  backend.time = 0.26;
  scheduler.tick();
  assert.equal(await playback.done, 'completed');
  assert.deepEqual(renderer.frames.at(-1)?.mouth, REST_MOUTH);
});

test('contiguous chunks retain coarticulation instead of resetting the mouth', async () => {
  const { backend, renderer, scheduler, playback, enqueue } = setup();
  await enqueue(0);
  playback.append(0, timeline());
  await enqueue(1);
  playback.append(1, timeline({ cues: [{ phoneme: 'u', startMs: 0, endMs: 100, pose: { ...REST_MOUTH, jaw: 0.2, rounding: 1 } }] }));
  backend.time = 0.16;
  scheduler.tick();
  assert.ok(Math.abs(renderer.frames.at(-1)!.mouth.jaw - 0.8) < 0.001);
});

test('underrun returns to rest without completing an unsealed stream', async () => {
  const { backend, renderer, scheduler, playback, enqueue } = setup();
  await enqueue(0);
  playback.append(0, timeline());
  backend.time = 0.3;
  scheduler.tick();
  assert.equal(playback.status(), 'buffering');
  assert.deepEqual(renderer.frames.at(-1)?.mouth, REST_MOUTH);
  await enqueue(1);
  playback.append(1, timeline());
  backend.time = 0.36;
  scheduler.tick();
  assert.ok(renderer.frames.at(-1)!.mouth.jaw < 0.001);
});

test('bad identity, audio, sequence or estimated cues leave the existing stream intact', async () => {
  const { playback, enqueue } = setup();
  await enqueue(0);
  assert.throws(() => playback.append(0, timeline({ identity: { ...identity, id: 'other' } })), /identity mismatch/);
  assert.throws(() => playback.append(0, timeline({ audioSha256: 'b'.repeat(64) })), /PCM digest/);
  assert.throws(() => playback.append(1, timeline()), /out of order/);
  assert.throws(() => playback.append(0, timeline({ timingSource: 'estimated' })), /not accepted/);
  playback.append(0, timeline());
  assert.equal(playback.status(), 'buffering');
});

test('batch film is not advertised as realtime and unsupported tongue articulation is rejected', async () => {
  assert.throws(() => new CharacterStreamSession(identity, { ...rig(), mode: 'batch-film' }, new Scheduler()), /Batch movies/);
  const { playback, enqueue } = setup();
  await enqueue(0);
  assert.throws(() => playback.append(0, timeline({
    cues: [{ phoneme: 'r', startMs: 0, endMs: 100, pose: { ...REST_MOUTH, tongueTip: 1 } }],
  })), /cannot articulate: tongueTip/);
});

test('replacement stops owned audio and stale callbacks cannot update the new character turn', async () => {
  const { backend, renderer, scheduler, session, playback, enqueue } = setup();
  await enqueue(0);
  playback.append(0, timeline());
  const second = new PcmStreamPlayer(backend, { streamId: 'turn-2' });
  const next = session.begin(second);
  assert.equal(await playback.done, 'replaced');
  assert.equal(backend.stops, 1);
  scheduler.tick();
  assert.ok(renderer.frames.every(frame => frame.generation === next.generation));
  assert.throws(() => playback.append(1, timeline()), /not accepting/);
  next.cancel();
  assert.equal(await next.done, 'cancelled');
});

test('late articulation is rejected instead of playing a mismatched mouth animation', async () => {
  const { backend, playback, enqueue } = setup();
  await enqueue(0);
  backend.time = 0.11;
  assert.throws(() => playback.append(0, timeline()), /after its audio started/);
  playback.cancel();
});
