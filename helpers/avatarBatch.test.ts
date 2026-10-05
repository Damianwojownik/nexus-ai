import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvatarBatchRequest, validateAvatarVideoFile } from './avatarBatch.ts';

const id = '01234567-89ab-cdef-0123-456789abcdef';
const png = `data:image/png;base64,${Buffer.from('\x89PNG\r\n\x1a\nTEST', 'latin1').toString('base64')}`;

test('Colab request carries exact portrait and script, without paths or credentials', () => {
  assert.deepEqual(createAvatarBatchRequest(png, '  Cześć  ', id), {
    version: 1, kind: 'nexus-face-job', requestId: id, mime: 'image/png',
    image: png.split(',')[1], text: 'Cześć',
  });
  assert.equal(createAvatarBatchRequest(png, 'x'.repeat(300), id).text.length, 300);
});

test('Colab request rejects invalid inputs and mismatched image signatures', () => {
  for (const text of ['', ' ', 'x'.repeat(301)]) assert.throws(() => createAvatarBatchRequest(png, text, id), /300/);
  assert.throws(() => createAvatarBatchRequest(png, 'Hello', '../job'), /identyfikator/);
  assert.throws(() => createAvatarBatchRequest(png.replace('png', 'jpeg'), 'Hello', id), /formatowi/);
  assert.throws(() => createAvatarBatchRequest('data:image/png;base64,!!!', 'Hello', id), /PNG/);
  const huge = `data:image/png;base64,${Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(5 * 1024 * 1024)]).toString('base64')}`;
  assert.throws(() => createAvatarBatchRequest(huge, 'Hello', id), /5 MB/);
});

test('Video import accepts bounded MP4, not images or empty/oversized files', () => {
  validateAvatarVideoFile({ name: 'nexus.MP4', size: 256 * 1024 * 1024 });
  for (const file of [{ name: 'photo.png', size: 100 }, { name: 'clip.mp4', size: 0 }, { name: 'clip.mp4', size: 256 * 1024 * 1024 + 1 }]) {
    assert.throws(() => validateAvatarVideoFile(file));
  }
});
