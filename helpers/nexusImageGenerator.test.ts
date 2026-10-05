import test from 'node:test';
import assert from 'node:assert/strict';
import { generateNexusImage } from './nexusImageGenerator.ts';

test('Nexus image generator requests a PNG from the local Agent Hub', async () => {
  let requestedUrl = '';
  let requestedBody: unknown;
  const result = await generateNexusImage('http://127.0.0.1:8788/', 'A green cybernetic portrait', async (input, init) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body));
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: {
        'Content-Type': 'image/png',
        'X-Nexus-Model': 'test-model',
        'X-Nexus-Seed': '42',
      },
    });
  });

  assert.equal(requestedUrl, 'http://127.0.0.1:8788/api/image/generate');
  assert.deepEqual(requestedBody, { prompt: 'A green cybernetic portrait' });
  assert.equal(result.image.type, 'image/png');
  assert.equal(result.model, 'test-model');
  assert.equal(result.seed, '42');
});

test('Nexus image generator surfaces server errors and rejects non-PNG responses', async () => {
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
