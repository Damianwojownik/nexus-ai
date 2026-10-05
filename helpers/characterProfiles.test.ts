import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CHARACTER_PROFILES, characterProfile, verifiedCharacterPortrait } from './characterProfiles.ts';
import { createAvatarBatchRequest } from './avatarBatch.ts';

test('each original character asset matches its pinned identity and can create an existing cloud batch job', async () => {
  for (const profile of CHARACTER_PROFILES) {
    const path = new URL(`../public${profile.portrait}`, import.meta.url);
    const bytes = await readFile(path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), profile.identity.referenceSha256);
    const blob = await verifiedCharacterPortrait(profile.identity.id, async () => new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
    const data = `data:image/png;base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
    const job = createAvatarBatchRequest(data, 'Cześć!', '12345678-1234-1234-1234-123456789abc');
    assert.equal(job.kind, 'nexus-face-job');
    assert.equal(job.text, 'Cześć!');
    assert.equal(Buffer.from(job.image, 'base64').equals(bytes), true);
  }
});

test('unknown profiles and changed references fail before preparing a job', async () => {
  assert.throws(() => characterProfile('missing'), /Unknown/);
  await assert.rejects(verifiedCharacterPortrait('bear', async () => new Response('changed')), /hash mismatch/);
  await assert.rejects(verifiedCharacterPortrait('bear', async () => new Response('', { status: 404 })), /HTTP 404/);
  await assert.rejects(verifiedCharacterPortrait('bear', async () => new Response('')), /1 byte/);
});
