import test from 'node:test';
import assert from 'node:assert/strict';
import { REST_MOUTH } from './characterEngine.ts';
import type { CharacterTimeline } from './characterEngine.ts';
import { CharacterSession, validateRigCapabilities } from './characterSession.ts';
import type { CharacterAudioClock, CharacterRenderer, CharacterSessionFrame, FrameScheduler, RigCapabilities } from './characterSession.ts';

const identity = { id: 'luna', revision: '1', referenceSha256: 'a'.repeat(64), rigRevision: 'rig-1' };
const audio = 'b'.repeat(64);
const ALL = ['jaw', 'width', 'rounding', 'lipClosure', 'tongueTip', 'tongueBack', 'teethContact'] as const;

const timeline = (overrides: Partial<CharacterTimeline> = {}): CharacterTimeline => ({
  identity: { ...identity }, audioSha256: audio, language: 'pl', timingSource: 'forced-alignment', durationMs: 1000,
  cues: [
    { phoneme: 'a', startMs: 100, endMs: 300, pose: { ...REST_MOUTH, jaw: 0.7 } },
    { phoneme: 'ʂ', startMs: 300, endMs: 500, pose: { ...REST_MOUTH, jaw: 0.3, tongueTip: 0.8, teethContact: 0.5 } },
  ],
  ...overrides,
});

class ManualScheduler implements FrameScheduler {
  callbacks = new Map<number, () => void>();
  private next = 0;
  private readonly honourCancel: boolean;
  constructor(honourCancel = true) { this.honourCancel = honourCancel; }
  request(callback: () => void) { this.callbacks.set(++this.next, callback); return this.next; }
  cancel(handle: unknown) { if (this.honourCancel) this.callbacks.delete(handle as number); }
  flush() { const pending = [...this.callbacks.values()]; this.callbacks.clear(); for (const cb of pending) cb(); }
}

class FakeClock implements CharacterAudioClock {
  listeners = new Set<() => void>();
  position = 0;
  readonly audioSha256: string;
  readonly durationMs: number;
  private readonly honourUnsubscribe: boolean;
  constructor(audioSha256 = audio, durationMs = 1000, honourUnsubscribe = true) {
    this.audioSha256 = audioSha256; this.durationMs = durationMs; this.honourUnsubscribe = honourUnsubscribe;
  }
  positionMs() { return this.position; }
  onEnded(listener: () => void) { this.listeners.add(listener); return () => { if (this.honourUnsubscribe) this.listeners.delete(listener); }; }
  end() { for (const listener of [...this.listeners]) listener(); }
}

const renderer = (capabilities: Partial<RigCapabilities> = {}) => {
  const frames: CharacterSessionFrame[] = [];
  const value: CharacterRenderer & { frames: CharacterSessionFrame[]; fail?: boolean } = {
    id: 'test-rig', frames,
    capabilities: { rigRevision: identity.rigRevision, referenceSha256: identity.referenceSha256, channels: [...ALL], ...capabilities },
    render(frame) { if (value.fail) throw new Error('gpu lost'); frames.push(frame); },
  };
  return value;
};

test('frames follow the audio clock position and completion returns the rig to rest', async () => {
  const rig = renderer();
  const scheduler = new ManualScheduler();
  const session = new CharacterSession(identity, rig, scheduler);
  const clock = new FakeClock();
  const playback = session.play(timeline(), clock);
  clock.position = 200;
  scheduler.flush();
  assert.equal(rig.frames.at(-1)?.phoneme, 'a');
  assert.equal(rig.frames.at(-1)?.audioMs, 200);
  assert.equal(rig.frames.at(-1)?.mouth.jaw, 0.7);
  assert.equal(rig.frames.at(-1)?.timingSource, 'forced-alignment');
  clock.position = 450;
  scheduler.flush();
  assert.equal(rig.frames.at(-1)?.mouth.tongueTip, 0.8);
  assert.equal(rig.frames.at(-1)?.generation, playback.generation);
  clock.position = 1000;
  scheduler.flush();
  assert.equal(await playback.done, 'completed');
  assert.deepEqual(rig.frames.at(-1)?.mouth, REST_MOUTH);
  assert.equal(scheduler.callbacks.size, 0);
  assert.equal(session.current, undefined);
});

test('audio ended event completes playback and unsubscribes', async () => {
  const session = new CharacterSession(identity, renderer(), new ManualScheduler());
  const clock = new FakeClock();
  const playback = session.play(timeline(), clock);
  clock.end();
  assert.equal(await playback.done, 'completed');
  assert.equal(clock.listeners.size, 0);
});

test('mismatched reference, rig, audio digest or duration fail explicitly', () => {
  assert.throws(() => new CharacterSession(identity, renderer({ referenceSha256: 'c'.repeat(64) }), new ManualScheduler()), /does not match character reference/);
  assert.throws(() => new CharacterSession(identity, renderer({ rigRevision: 'rig-2' }), new ManualScheduler()), /does not match character reference/);
  const session = new CharacterSession(identity, renderer(), new ManualScheduler());
  assert.throws(() => session.play(timeline(), new FakeClock('d'.repeat(64))), /Audio digest mismatch/);
  assert.throws(() => session.play(timeline(), new FakeClock('NOT-A-HASH')), /SHA-256/);
  assert.throws(() => session.play(timeline(), new FakeClock(audio, 1200)), /Audio duration mismatch/);
  for (const bad of [0, -1, NaN, Infinity]) assert.throws(() => session.play(timeline(), new FakeClock(audio, bad)), /duration must be finite and positive/);
  const otherCharacter = timeline({ identity: { ...identity, referenceSha256: 'e'.repeat(64) } });
  assert.throws(() => session.play(otherCharacter, new FakeClock()), /identity mismatch/);
  assert.equal(session.current, undefined);
});

test('unknown or malformed capabilities are rejected', () => {
  assert.throws(() => validateRigCapabilities({ ...renderer().capabilities, eyelids: true } as unknown as RigCapabilities), /Unknown rig capability: eyelids/);
  assert.throws(() => validateRigCapabilities({ ...renderer().capabilities, channels: ['jaw', 'uvula'] } as unknown as RigCapabilities), /Unknown mouth channel capability: uvula/);
  assert.throws(() => validateRigCapabilities({ ...renderer().capabilities, channels: ['jaw', 'jaw'] }), /Duplicate/);
  assert.throws(() => new CharacterSession(identity, renderer(), new ManualScheduler(), { acceptedTimingSources: ['guessed' as never] }), /Unknown timing source/);
});

test('rig without tongue/teeth refuses such timelines by default and never presents them when suppressing', () => {
  const lipsOnly = { channels: ['jaw', 'width', 'rounding', 'lipClosure'] as const };
  const strict = new CharacterSession(identity, renderer({ channels: [...lipsOnly.channels] }), new ManualScheduler());
  assert.throws(() => strict.play(timeline(), new FakeClock()), /cannot articulate: tongueTip, teethContact/);

  const rig = renderer({ channels: [...lipsOnly.channels] });
  const scheduler = new ManualScheduler();
  const session = new CharacterSession(identity, rig, scheduler, { unsupportedArticulation: 'suppress' });
  const clock = new FakeClock();
  const playback = session.play(timeline(), clock);
  assert.deepEqual(playback.suppressedChannels, ['tongueTip', 'teethContact']);
  clock.position = 450;
  scheduler.flush();
  const frame = rig.frames.at(-1)!;
  assert.equal(frame.mouth.jaw, 0.3);
  assert.equal(frame.mouth.tongueTip, 0);
  assert.equal(frame.mouth.teethContact, 0);
  assert.deepEqual(frame.suppressedChannels, ['tongueTip', 'teethContact']);
  assert.ok(!frame.supportedChannels.includes('tongueTip'));
});

test('estimated timing requires explicit opt-in and provenance is carried on frames', () => {
  const strict = new CharacterSession(identity, renderer(), new ManualScheduler());
  assert.throws(() => strict.play(timeline({ timingSource: 'estimated' }), new FakeClock()), /"estimated" is not accepted/);
  const rig = renderer();
  const scheduler = new ManualScheduler();
  const lenient = new CharacterSession(identity, rig, scheduler, { acceptedTimingSources: ['estimated'] });
  const playback = lenient.play(timeline({ timingSource: 'estimated' }), new FakeClock());
  scheduler.flush();
  assert.equal(playback.timingSource, 'estimated');
  assert.equal(rig.frames.at(-1)?.timingSource, 'estimated');
});

test('replacement and cancellation block stale frame and ended callbacks', async () => {
  const rig = renderer();
  const scheduler = new ManualScheduler(false);
  const session = new CharacterSession(identity, rig, scheduler);
  const oldClock = new FakeClock(audio, 1000, false);
  const first = session.play(timeline(), oldClock);
  const secondAudio = 'f'.repeat(64);
  const newClock = new FakeClock(secondAudio);
  const second = session.play(timeline({ audioSha256: secondAudio }), newClock);
  assert.equal(await first.done, 'replaced');
  oldClock.position = 200;
  newClock.position = 450;
  scheduler.flush();
  assert.equal(rig.frames.length, 1);
  assert.equal(rig.frames[0].generation, second.generation);
  oldClock.end();
  assert.equal(second.status(), 'playing');

  assert.throws(() => session.play(timeline(), new FakeClock('d'.repeat(64))), /digest mismatch/);
  assert.equal(second.status(), 'playing');

  second.cancel();
  assert.equal(await second.done, 'cancelled');
  assert.deepEqual(rig.frames.at(-1)?.mouth, REST_MOUTH);
  const count = rig.frames.length;
  scheduler.flush();
  newClock.end();
  assert.equal(rig.frames.length, count);
  session.dispose();
  assert.throws(() => session.play(timeline(), new FakeClock()), /disposed/);
});

test('invalid clock positions and renderer errors fail the playback explicitly', async () => {
  const scheduler = new ManualScheduler();
  const session = new CharacterSession(identity, renderer(), scheduler);
  const clock = new FakeClock();
  const playback = session.play(timeline(), clock);
  clock.position = NaN;
  scheduler.flush();
  assert.equal(await playback.done, 'failed');
  assert.match(playback.error()!.message, /position must be finite/);

  const rig = renderer();
  const failing = new CharacterSession(identity, rig, scheduler);
  const broken = failing.play(timeline(), new FakeClock());
  rig.fail = true;
  scheduler.flush();
  assert.equal(await broken.done, 'failed');
  assert.match(broken.error()!.message, /gpu lost/);
  assert.equal(scheduler.callbacks.size, 0);
});