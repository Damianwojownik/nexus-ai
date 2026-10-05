import test from 'node:test';
import assert from 'node:assert/strict';
import { CharacterEngine, REST_MOUTH, measureTiming } from './characterEngine.ts';
import type { CharacterTimeline } from './characterEngine.ts';

const identity = { id: 'luna', revision: '1', referenceSha256: 'a'.repeat(64), rigRevision: '1' };
const timeline = (): CharacterTimeline => ({
  identity: { ...identity }, audioSha256: 'b'.repeat(64), language: 'pl',
  timingSource: 'tts-phonemes', durationMs: 3600000,
  cues: [
    { phoneme: 's', startMs: 100, endMs: 200, pose: { ...REST_MOUTH, jaw: 0.2, tongueTip: 0.4 } },
    { phoneme: 'ʂ', startMs: 200, endMs: 300, pose: { ...REST_MOUTH, jaw: 0.3, tongueTip: 0.8, rounding: 0.3 } },
  ],
});

test('identity is immutable across an hour and rejects a different reference or rig', () => {
  const sourceIdentity = { ...identity };
  const engine = new CharacterEngine(sourceIdentity);
  engine.load(timeline());
  sourceIdentity.id = 'edited';
  assert.equal(engine.sample(3599999).identity.id, 'luna');
  for (const key of ['id', 'revision', 'referenceSha256', 'rigRevision'] as const) {
    const different = timeline();
    different.identity[key] = key === 'referenceSha256' ? 'c'.repeat(64) : 'different';
    assert.throws(() => engine.load(different), /identity mismatch/);
  }
});

test('audio position owns timing, distinct articulation channels survive, and interruption resets', () => {
  const engine = new CharacterEngine(identity);
  engine.load(timeline());
  assert.deepEqual(engine.sample(50).mouth, REST_MOUTH);
  assert.equal(engine.sample(150).mouth.tongueTip, 0.4);
  assert.equal(engine.sample(250).mouth.tongueTip, 0.8);
  assert.equal(engine.sample(250).phoneme, 'ʂ');
  assert.equal(engine.sample(200).mouth.tongueTip, 0.4);
  assert.ok(engine.sample(220).mouth.tongueTip > 0.4);
  assert.deepEqual(engine.sample(300).mouth, REST_MOUTH);
  assert.deepEqual(engine.sample(3600000).mouth, REST_MOUTH);
  engine.interrupt();
  assert.deepEqual(engine.sample(150).mouth, REST_MOUTH);
  assert.equal(engine.sample(150).phoneme, null);
});

test('caller mutation cannot change a loaded session; bad timing fails explicitly', () => {
  const engine = new CharacterEngine(identity);
  const source = timeline();
  engine.load(source);
  source.cues[0].pose.tongueTip = 1;
  assert.equal(engine.sample(150).mouth.tongueTip, 0.4);
  for (const invalid of [NaN, Infinity, -1]) assert.throws(() => engine.sample(invalid), /finite/);
  const overlap = timeline();
  overlap.cues[1].startMs = 150;
  assert.throws(() => engine.load(overlap), /non-overlapping/);
  const pose = timeline();
  pose.cues[0].pose.jaw = NaN;
  assert.throws(() => engine.load(pose), /0..1/);
});

test('timing benchmark uses measured offsets and does not manufacture success', () => {
  assert.deepEqual(measureTiming([
    { expectedAudioMs: 1000, observedMotionMs: 640 },
    { expectedAudioMs: 2000, observedMotionMs: 1640 },
  ]), { count: 2, medianOffsetMs: -360, maxAbsoluteOffsetMs: 360 });
  assert.throws(() => measureTiming([]), /measured observations/);
});
