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
    const mime = profile.portrait.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    if (profile.expressionReferences) {
      const hashes = profile.expressionReferenceSha256;
      assert.ok(hashes);
      for (const { path, sha256 } of [
        { path: profile.expressionReferences.blink, sha256: hashes.blink },
        { path: profile.expressionReferences.glance, sha256: hashes.glance },
      ]) {
        const frameBytes = await readFile(new URL(`../public${path}`, import.meta.url));
        assert.equal(createHash('sha256').update(frameBytes).digest('hex'), sha256);
      }
    }
    const blob = await verifiedCharacterPortrait(profile.identity.id, async () => new Response(bytes, { headers: { 'Content-Type': mime } }));
    const data = `data:${mime};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
    const job = createAvatarBatchRequest(data, 'Cześć!', '12345678-1234-1234-1234-123456789abc');
    assert.equal(job.kind, 'nexus-face-job');
    assert.equal(job.text, 'Cześć!');
    assert.equal(Buffer.from(job.image, 'base64').equals(bytes), true);
  }
});

test('the canonical librarian uses one fixed primary portrait and keeps expressions as references only', () => {
  const profile = characterProfile('nexus-librarian');
  assert.ok(profile.expressionReferences);
  assert.equal(profile.portrait, '/avatars/references/nexus-librarian/nexus-librarian-front-facing.jpeg');
  assert.equal(profile.identity.rigRevision, 'neural-stream-v1');
  assert.notEqual(profile.expressionReferences.blink, profile.portrait);
  assert.notEqual(profile.expressionReferences.glance, profile.portrait);
  assert.deepEqual(profile.expressionReferenceSha256, {
    blink: 'f59341b3d82d458dccc5c655e9315e1cb39edf6d5d2b937408632a14ae604de9',
    glance: '8615dbd338dc3ff61fca9efc8501f179f8a3cacde42a0faabb0e5a9544b26fa8',
  });
  assert.equal(profile.renderingStatus, 'reference-only');
});

test('unknown profiles and changed references fail before preparing a job', async () => {
  assert.throws(() => characterProfile('missing'), /Unknown/);
  await assert.rejects(verifiedCharacterPortrait('bear', async () => new Response('changed')), /hash mismatch/);
  await assert.rejects(verifiedCharacterPortrait('bear', async () => new Response('', { status: 404 })), /HTTP 404/);
  await assert.rejects(verifiedCharacterPortrait('bear', async () => new Response('')), /1 byte/);
});
