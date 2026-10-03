import test from 'node:test';
import assert from 'node:assert/strict';
import { generateNexusImage } from './nexusImageGenerator.ts';

test('image generator sends the spoken prompt to the local Hub and accepts PNG output', async () => {
  let requestedUrl = '';
  let requestedBody: unknown;
  const png = new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
  const result = await generateNexusImage('http://127.0.0.1:8788/', 'green cybernetic portrait', async (input, init) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body));
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  });
  assert.equal(requestedUrl, 'http://127.0.0.1:8788/api/image/generate');
  assert.deepEqual(requestedBody, { prompt: 'green cybernetic portrait' });
  assert.equal(result.image.type, 'image/png');
});

test('image generator surfaces engine errors and rejects non-PNG output', async () => {
  await assert.rejects(
    generateNexusImage('http://127.0.0.1:8788', 'portrait', async () =>
      Response.json({ error: 'Image Engine is not connected' }, { status: 503 })),
    /Image Engine is not connected/,
  );
  await assert.rejects(
    generateNexusImage('http://127.0.0.1:8788', 'portrait', async () =>
      new Response('not an image', { headers: { 'Content-Type': 'text/plain' } })),
    /unsupported image format/,
  );
});
