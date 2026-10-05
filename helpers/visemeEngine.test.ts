import test from 'node:test';
import assert from 'node:assert/strict';
import { appendSapiVisemeCue, estimateVisemePlan, sampleVisemeAt } from './visemeEngine.ts';

test('estimated articulation returns to rest after speech and within gaps', () => {
  const cues = estimateVisemePlan('Luna');
  assert.equal(sampleVisemeAt(cues, cues[cues.length - 1].endMs + 100).viseme, 'REST');
  assert.equal(sampleVisemeAt([{ viseme: 'A', startMs: 100, endMs: 200, intensity: 1 }], 50).viseme, 'REST');
  assert.equal(sampleVisemeAt(cues, 0).viseme, cues[0].viseme);
});

test('native SAPI visemes map all 22 IDs into mouth cues with their audio timing', () => {
  const expected = ['REST', 'A', 'A', 'O', 'E', 'R', 'I', 'U', 'O', 'A', 'O',
    'A', 'A', 'R', 'L', 'SZ', 'SZ', 'TD', 'FV', 'TD', 'KG', 'MBP'];
  const cues: ReturnType<typeof estimateVisemePlan> = [];
  expected.forEach((viseme, id) => appendSapiVisemeCue(cues, id, id * 40, 60, id === 21 ? 2 : 0));
  assert.deepEqual(cues.map(cue => cue.viseme), expected);
  assert.equal(cues[0].intensity, 0);
  assert.equal(cues[21].intensity, 1);
  assert.equal(cues[0].endMs, 40);
  assert.equal(sampleVisemeAt(cues, 21 * 40).viseme, 'MBP');
});

test('native viseme cues reject invalid timing and keep overlaps deterministic', () => {
  assert.throws(() => appendSapiVisemeCue([], 22, 0, 30), /0 to 21/);
  assert.throws(() => appendSapiVisemeCue([], 1, -1, 30), /start/);
  assert.throws(() => appendSapiVisemeCue([], 1, 0, Number.NaN), /duration/);
  assert.throws(() => appendSapiVisemeCue([], 1, 0, 20, 3), /emphasis/);

  const cues: ReturnType<typeof estimateVisemePlan> = [];
  appendSapiVisemeCue(cues, 2, 0, 120);
  appendSapiVisemeCue(cues, 21, 80, 20);
  assert.equal(cues[0].endMs, 80);
  assert.equal(sampleVisemeAt(cues, 79).viseme, 'A');
  assert.equal(sampleVisemeAt(cues, 80).viseme, 'MBP');
  appendSapiVisemeCue(cues, 0, 80, 0);
  assert.equal(cues.length, 2);
  assert.equal(cues[1].endMs, 81);
  assert.equal(sampleVisemeAt(cues, 80).viseme, 'REST');
});
