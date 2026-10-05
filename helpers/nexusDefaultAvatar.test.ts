import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { NEXUS_DEFAULT_AVATAR } from './nexusDefaultAvatar.ts';

test('canonical Nexus is the pinned frontal librarian portrait, not a legacy android video', async () => {
  const portrait = await readFile(new URL(`../public${NEXUS_DEFAULT_AVATAR.portrait}`, import.meta.url));
  assert.equal(createHash('sha256').update(portrait).digest('hex'), NEXUS_DEFAULT_AVATAR.sha256);
  assert.deepEqual([...portrait.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.equal(NEXUS_DEFAULT_AVATAR.id, 'nexus-librarian');
  assert.equal('video' in NEXUS_DEFAULT_AVATAR, false);
  assert.equal('idleVideo' in NEXUS_DEFAULT_AVATAR, false);
});
