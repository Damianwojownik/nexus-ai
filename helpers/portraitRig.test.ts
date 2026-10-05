import assert from 'node:assert/strict';
import test from 'node:test';
import { fitPortrait, followPortrait, neutralPortraitFrame, warpPortraitPoint, shouldAnimatePortrait } from './portraitRig.ts';

const head = { x: .5, y: .4, rx: .32, ry: .36 };
test('portrait fits without stretching or clipping across phone and desktop sizes', () => {
  for (const [width, height] of [[320, 460], [600, 300], [2, 2], [1200, 1800]]) {
    const fit = fitPortrait(width, height, .75);
    assert.ok(fit.x >= 0 && fit.y >= 0);
    assert.ok(fit.x + fit.width <= width && fit.y + fit.height <= height);
    assert.ok(Math.abs(fit.width / fit.height - .75) < 1e-10);
  }
});
test('rig leaves the scene boundary fixed instead of rotating the entire photo', () => {
  const frame = { ...neutralPortraitFrame, headX: 4, headY: 3, breath: 1, shoulder: 2, bodyX: 2 };
  for (const [x, y] of [[0, 0], [1, 1], [0, .5], [1, .5], [.4, 0], [.4, 1]]) {
    const point = warpPortraitPoint(x, y, frame, head);
    assert.ok(Math.abs(point.x - x) < 1e-10 && Math.abs(point.y - y) < 1e-10);
  }
  assert.notDeepEqual(warpPortraitPoint(.5, .4, frame, head), { x: .5, y: .4 });
});
test('head and shoulders move independently with bounded displacement', () => {
  for (let row = 0; row <= 12; row++) for (let col = 0; col <= 8; col++) {
    const x = col / 8, y = row / 12;
    const frame = { ...neutralPortraitFrame, headX: 1e6, headY: 1e6, shoulder: 1e6, gazeX: 1e6, breath: 1e6 };
    const point = warpPortraitPoint(x, y, frame, head);
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    assert.ok(Math.abs(point.x - x) < .025 && Math.abs(point.y - y) < .025);
  }
});
test('reduced motion produces an undeformed portrait', () => {
  const frame = { ...neutralPortraitFrame, headX: 3, breath: 1, shoulder: 1 };
  assert.deepEqual(warpPortraitPoint(.47, .38, frame, head, true), { x: .47, y: .38 });
});
test('smoothing is independent of frame rate and cannot overshoot', () => {
  let fast = 0, slow = 0;
  for (let i = 0; i < 60; i++) fast = followPortrait(fast, 1, 1 / 60, 8);
  for (let i = 0; i < 30; i++) slow = followPortrait(slow, 1, 1 / 30, 8);
  assert.ok(Math.abs(fast - slow) < 1e-10);
  assert.ok(followPortrait(.8, 0, 100, 8) >= 0);
  assert.equal(followPortrait(.8, 0, -1, 8), .8);
});
test('audible speech animates in an embedded hidden preview, while hidden idle pauses', () => {
  assert.equal(shouldAnimatePortrait(true, true), true);
  assert.equal(shouldAnimatePortrait(true, false), false);
  assert.equal(shouldAnimatePortrait(false, false), true);
});
