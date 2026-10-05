import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { NEXUS_DEFAULT_AVATAR } from './nexusDefaultAvatar.ts';

test('default avatar is the exact user-approved android video, not an earlier experiment', async () => {
  const video = await readFile(new URL(`../public${NEXUS_DEFAULT_AVATAR.video}`, import.meta.url));
  assert.equal(createHash('sha256').update(video).digest('hex'), NEXUS_DEFAULT_AVATAR.sha256);
  assert.equal(video.toString('ascii', 4, 8), 'ftyp');
  assert.equal(NEXUS_DEFAULT_AVATAR.id, 'android-face-test-9ebe69ed');
});

test('default android has a valid original-frame PNG poster at full resolution', async () => {
  const poster = await readFile(new URL(`../public${NEXUS_DEFAULT_AVATAR.portrait}`, import.meta.url));
  assert.deepEqual([...poster.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(poster.readUInt32BE(16), NEXUS_DEFAULT_AVATAR.width);
  assert.equal(poster.readUInt32BE(20), NEXUS_DEFAULT_AVATAR.height);
});

test('idle blink uses its own verified silent clip, not the talking loop', async () => {
  assert.notEqual(NEXUS_DEFAULT_AVATAR.idleVideo, NEXUS_DEFAULT_AVATAR.video);
  const video = await readFile(new URL(`../public${NEXUS_DEFAULT_AVATAR.idleVideo}`, import.meta.url));
  assert.equal(createHash('sha256').update(video).digest('hex'), NEXUS_DEFAULT_AVATAR.idleSha256);
  assert.equal(video.toString('ascii', 4, 8), 'ftyp');
  assert.equal(NEXUS_DEFAULT_AVATAR.idleDurationSeconds, 5.04);
});
