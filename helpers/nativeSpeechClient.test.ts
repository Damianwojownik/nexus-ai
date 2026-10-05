import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { nativeSpeechUrl, playNativePaulinaStream } from './nativeSpeechClient.ts';
import type { PcmPlaybackBackend } from './pcmStream.ts';

const format = { encoding: 'PCM16LE', sampleRate: 16000, channels: 1, bitsPerSample: 16 } as const;
const identity = { voice: 'Microsoft Paulina Desktop', language: 'pl-PL', cost: 0, device: 'cpu' } as const;
const bytes = Buffer.alloc(640, 1);
const events = [
  { type: 'start', requestId: 'turn', ...format, ...identity },
  { type: 'audio', requestId: 'turn', ...format, sequence: 0, startSample: 0, sampleCount: 320,
    bytesBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') },
  { type: 'end', requestId: 'turn', totalSamples: 320, chunks: 1, phonemes: 0, visemes: 0,
    audioDurationMs: 20, synthesisMs: 30, firstPcmMs: 5 },
];

class Backend implements PcmPlaybackBackend {
  time = 0;
  scheduled = 0;
  stopped = 0;
  nowSeconds() { return this.time; }
  async resume() {}
  schedule(samples: Float32Array, rate: number, when: number, ended: () => void) {
    this.scheduled++;
    const timer = setTimeout(() => { this.time = when + samples.length / rate; ended(); }, 1);
    return { stop: () => { clearTimeout(timer); this.stopped++; } };
  }
}

function fetcher(packets: unknown[] = events): typeof fetch {
  return async () => new Response(packets.map(packet => JSON.stringify(packet) + '\n').join(''), {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

test('native speech is restricted to local credential-free endpoints', () => {
  assert.equal(nativeSpeechUrl('http://127.0.0.1:8788'), 'http://127.0.0.1:8788/api/speech/stream');
  for (const url of ['https://example.com', 'file:///C:/speech', 'http://user:pass@localhost', 'http://localhost?token=x']) {
    assert.throws(() => nativeSpeechUrl(url), /local, credential-free/);
  }
});

test('browser client verifies and schedules native PCM then waits for actual playback completion', async () => {
  const backend = new Backend();
  let scheduled = 0;
  const result = await playNativePaulinaStream('http://127.0.0.1:8788', 'Cześć', new AbortController().signal, {
    backend, fetch: fetcher(), onAudioScheduled: () => scheduled++,
  });
  assert.equal(result.totalSamples, 320);
  assert.equal(backend.scheduled, 1);
  assert.equal(scheduled, 1);
  assert.equal(backend.stopped, 0);
});

test('bad digest, request identity, missing end or final counters fail explicitly', async () => {
  for (const packets of [
    [events[0], { ...events[1], sha256: '0'.repeat(64) }, events[2]],
    [events[0], { ...events[1], requestId: 'wrong' }, events[2]],
    [events[0], events[1]],
    [events[0], events[1], { ...events[2], totalSamples: 640, audioDurationMs: 40 }],
  ]) {
    await assert.rejects(playNativePaulinaStream('http://localhost:8788', 'Cześć', new AbortController().signal, {
      backend: new Backend(), fetch: fetcher(packets),
    }));
  }
});

test('native stream rejects remote errors and aborts without a voice fallback', async () => {
  const failure = [{ type: 'error', requestId: null, code: 'SYNTHESIS_FAILED', message: 'Voice unavailable' }];
  await assert.rejects(playNativePaulinaStream('http://localhost:8788', 'Cześć', new AbortController().signal, {
    backend: new Backend(), fetch: fetcher(failure),
  }), /Voice unavailable/);
  const controller = new AbortController();
  const backend = new Backend();
  await assert.rejects(playNativePaulinaStream('http://localhost:8788', 'Cześć', controller.signal, {
    backend, fetch: fetcher(), onAudioScheduled: () => controller.abort(),
  }));
  assert.equal(backend.stopped, 1);
});
