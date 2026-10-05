import { parsePaulinaSpeechEvent, decodePaulinaAudioBase64 } from './paulinaSpeechProtocol.ts';
import type { PaulinaEndEvent, PaulinaSpeechEvent } from './paulinaSpeechProtocol.ts';
import { browserPcmBackend, PcmBackpressureError, PcmStreamPlayer } from './pcmStream.ts';
import type { PcmPlaybackBackend } from './pcmStream.ts';

export interface NativeSpeechPlaybackOptions {
  backend?: PcmPlaybackBackend;
  fetch?: typeof fetch;
  onClock?: (clock: PcmStreamPlayer) => void;
  onAudioScheduled?: () => void;
  onCue?: (event: Extract<PaulinaSpeechEvent, { type: 'phoneme' | 'viseme' }>) => void;
}

export function nativeSpeechUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) {
    throw new Error('Native Paulina streaming requires a local, credential-free Agent Hub URL');
  }
  return `${url.href.replace(/\/$/, '')}/api/speech/stream`;
}

function waitForAudio(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, 15);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** Native PCM playback, not an MP4 loop or a neural renderer. Native cue provenance is retained. */
export async function playNativePaulinaStream(
  baseUrl: string, text: string, signal: AbortSignal, options: NativeSpeechPlaybackOptions = {},
): Promise<PaulinaEndEvent> {
  const endpoint = nativeSpeechUrl(baseUrl);
  if (typeof text !== 'string' || !text.trim() || text.length > 6000) throw new Error('Native speech requires 1-6000 characters');
  signal.throwIfAborted();
  let context: AudioContext | undefined;
  const backend = options.backend ?? browserPcmBackend(context = new AudioContext());
  const player = new PcmStreamPlayer(backend, { streamId: crypto.randomUUID() });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  const aborted = () => { player.stop(); };
  signal.addEventListener('abort', aborted, { once: true });
  try {
    await backend.resume();
    signal.throwIfAborted();
    options.onClock?.(player);
    const response = await (options.fetch ?? fetch)(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ text }), signal,
    });
    if (!response.ok) {
      const body: unknown = await response.json();
      const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error : `Native speech HTTP ${response.status}`;
      throw new Error(message);
    }
    if (!response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error('Native speech response is not a stream');
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '';
    let requestId: string | undefined;
    let samples = 0, chunks = 0, phonemes = 0, visemes = 0;
    let lastPhonemeMs = -1, lastVisemeMs = -1;
    let end: PaulinaEndEvent | undefined;
    for (;;) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) { pending += decoder.decode(); break; }
      pending += decoder.decode(result.value, { stream: true });
      for (let newline; (newline = pending.indexOf('\n')) >= 0;) {
        if (new TextEncoder().encode(pending.slice(0, newline)).length > 8192) throw new Error('Oversized native speech packet');
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const event = parsePaulinaSpeechEvent(line);
        if (event.type === 'error') throw new Error(event.message);
        if (event.type === 'ready' || end) throw new Error('Invalid native speech response ordering');
        if (event.type === 'start') {
          if (requestId) throw new Error('Duplicate native speech start');
          requestId = event.requestId;
          continue;
        }
        if (!requestId || event.requestId !== requestId) throw new Error('Native speech request identity mismatch');
        if (event.type === 'audio') {
          if (event.sequence !== chunks || event.startSample !== samples) throw new Error('Discontinuous native PCM stream');
          const pcm16 = decodePaulinaAudioBase64(event.bytesBase64, event.sampleCount);
          for (;;) {
            signal.throwIfAborted();
            try {
              await player.enqueue({ sequence: event.sequence, sampleRate: event.sampleRate, pcm16, sha256: event.sha256 });
              break;
            } catch (error) {
              if (!(error instanceof PcmBackpressureError)) throw error;
              await waitForAudio(signal);
            }
          }
          samples += event.sampleCount;
          if (chunks++ === 0) options.onAudioScheduled?.();
        } else if (event.type === 'phoneme' || event.type === 'viseme') {
          const previous = event.type === 'phoneme' ? lastPhonemeMs : lastVisemeMs;
          if (event.audioPositionMs < previous) throw new Error('Native cue timing moved backwards');
          if (event.type === 'phoneme') { phonemes++; lastPhonemeMs = event.audioPositionMs; }
          else { visemes++; lastVisemeMs = event.audioPositionMs; }
          options.onCue?.(event);
        } else if (event.type === 'end') {
          if (event.totalSamples !== samples || event.chunks !== chunks || event.phonemes !== phonemes
            || event.visemes !== visemes || Math.max(lastPhonemeMs, lastVisemeMs) > event.audioDurationMs) {
            throw new Error('Native speech final counters/duration mismatch');
          }
          end = event;
        }
      }
      if (new TextEncoder().encode(pending).length > 8192) throw new Error('Oversized native speech packet');
    }
    if (pending.length || !end) throw new Error('Native speech stream ended without a complete result');
    const playbackEnded = new Promise<void>((resolve, reject) => {
      const unsubscribe = player.onEnded(() => { signal.removeEventListener('abort', cancelled); resolve(); });
      const cancelled = () => { unsubscribe(); signal.removeEventListener('abort', cancelled); reject(signal.reason); };
      signal.addEventListener('abort', cancelled, { once: true });
      if (signal.aborted) cancelled();
    });
    player.seal();
    await playbackEnded;
    signal.throwIfAborted();
    completed = true;
    return end;
  } finally {
    signal.removeEventListener('abort', aborted);
    if (!completed) player.stop();
    if (reader) {
      try { await reader.cancel(); }
      catch (error) { console.error('Native speech reader cleanup failed:', error); }
      reader.releaseLock();
    }
    if (context) await context.close();
  }
}
