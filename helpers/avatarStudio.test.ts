import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForAvatarVideo, requestPolishAudio } from './avatarStudio.ts';

test('studio reports progress and returns only a same-Hub video', async () => {
  let calls = 0;
  const progress: number[] = [];
  const video = await waitForAvatarVideo('http://127.0.0.1:8788', 'test', {
    signal: new AbortController().signal, intervalMs: 0, onProgress: attempt => progress.push(attempt),
    fetcher: async () => Response.json(++calls === 1 ? { status: 'processing' } : { status: 'complete', videoUrl: '/api/avatar/video/test' }),
  });
  assert.equal(video, 'http://127.0.0.1:8788/api/avatar/video/test');
  assert.deepEqual(progress, [1, 2]);
});
test('studio rejects failed, stalled and unsafe renders and respects cancellation', async () => {
  for (const result of [{ status: 'error', error: 'render failed' }, { status: 'complete', videoUrl: 'https://example.com/video' }, { status: 'complete' }, { status: 'unknown' }]) {
    await assert.rejects(waitForAvatarVideo('http://127.0.0.1:8788', 'test', {
      signal: new AbortController().signal, onProgress: () => {}, fetcher: async () => Response.json(result),
    }));
  }
  await assert.rejects(waitForAvatarVideo('http://127.0.0.1:8788', 'test', {
    signal: new AbortController().signal, onProgress: () => {}, intervalMs: 0, maxAttempts: 1,
    fetcher: async () => Response.json({ status: 'processing' }),
  }), /czas/);
  const controller = new AbortController();
  const pending = waitForAvatarVideo('http://127.0.0.1:8788', 'test', {
    signal: controller.signal, onProgress: () => {}, intervalMs: 10000,
    fetcher: async () => { queueMicrotask(() => controller.abort()); return Response.json({ status: 'processing' }); },
  });
  await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
});
test('downloaded studio audio must be real bounded WAV, not success-shaped data', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('invalid', { headers: { 'Content-Type': 'audio/wav' } });
    await assert.rejects(requestPolishAudio('http://localhost', 'hello', new AbortController().signal));
    const bytes = new Uint8Array(44);
    bytes.set(new TextEncoder().encode('RIFF'), 0);
    bytes.set(new TextEncoder().encode('WAVE'), 8);
    globalThis.fetch = async () => new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } });
    assert.equal((await requestPolishAudio('http://localhost', 'hello', new AbortController().signal)).size, 44);
  } finally { globalThis.fetch = original; }
});
