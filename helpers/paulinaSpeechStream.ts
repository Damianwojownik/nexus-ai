import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { validateSpeechText } from './localSpeech.ts';
import { PAULINA_PCM_FORMAT as PCM, PAULINA_IDENTITY as IDENTITY, PAULINA_MAX_PACKET_BYTES as MAX_LINE,
  parsePaulinaSpeechEvent as parseProtocolEvent, decodePaulinaAudioBase64 } from './paulinaSpeechProtocol.ts';
import type { PaulinaReadyEvent, PaulinaSpeechEvent, PaulinaSpeechHealth, PaulinaStreamMetrics } from './paulinaSpeechProtocol.ts';
export type { PaulinaReadyEvent, PaulinaEndEvent, PaulinaSpeechEvent, PaulinaSpeechHealth, PaulinaStreamMetrics } from './paulinaSpeechProtocol.ts';
function requirePacket(ok: unknown, message = 'Malformed Paulina packet'): asserts ok {
  if (!ok) throw new Error(message);
}
/** Compatibility parser: shared structural validation plus actual Node SHA-256 verification. */
export function parsePaulinaSpeechEvent(line: string): PaulinaSpeechEvent {
  const event = parseProtocolEvent(line);
  if (event.type === 'audio') {
    const bytes = decodePaulinaAudioBase64(event.bytesBase64, event.sampleCount);
    requirePacket(createHash('sha256').update(bytes).digest('hex') === event.sha256, 'Invalid Paulina PCM digest');
  }
  return event;
}
async function* packets(stdout: Readable): AsyncGenerator<PaulinaSpeechEvent> {
  let remainder = Buffer.alloc(0);
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of stdout) {
    remainder = Buffer.concat([remainder, chunk]);
    for (let newline; (newline = remainder.indexOf(10)) !== -1;) {
      requirePacket(newline <= MAX_LINE, 'Oversized Paulina packet');
      const line = remainder.subarray(0, newline); remainder = remainder.subarray(newline + 1);
      yield parsePaulinaSpeechEvent(utf8.decode(line));
    }
    requirePacket(remainder.length <= MAX_LINE, 'Oversized Paulina packet');
  }
  throw new Error(remainder.length ? 'Truncated Paulina packet' : 'Paulina worker output closed');
}
type Worker = {
  child: ChildProcessWithoutNullStreams; reader: AsyncGenerator<PaulinaSpeechEvent>; ready: Promise<PaulinaReadyEvent>;
  failure: Promise<never>; fail: (error: Error) => void;
};
export interface PaulinaStreamOptions {
  startupTimeoutMs?: number; synthesisTimeoutMs?: number;
  /** Test seam; the strict protocol still requires the exact local Paulina voice and CPU/zero-cost scope. */
  spawnWorker?: () => ChildProcessWithoutNullStreams;
}
/** Lazy CPU-only worker. Ready is exposed by health; callbacks receive request events.
 * Explicit close is terminal; cancellation permits a fresh worker.
 */
export class PaulinaSpeechStream {
  private worker?: Worker;
  private busy = false;
  private closed = false;
  private readonly options: Required<Pick<PaulinaStreamOptions, 'startupTimeoutMs' | 'synthesisTimeoutMs'>> & PaulinaStreamOptions;
  constructor(options: PaulinaStreamOptions = {}) {
    this.options = { ...options, startupTimeoutMs: options.startupTimeoutMs ?? 15000,
      synthesisTimeoutMs: options.synthesisTimeoutMs ?? 120000 };
    for (const ms of [this.options.startupTimeoutMs, this.options.synthesisTimeoutMs])
      requirePacket(Number.isSafeInteger(ms) && ms >= 1 && ms <= 300000, 'Invalid Paulina deadline');
  }
  private destroy(w: Worker, error = new Error('Paulina worker closed')) {
    if (this.worker === w) this.worker = undefined;
    w.fail(error); w.child.kill();
    w.child.stdin.destroy(); w.child.stdout.destroy(); w.child.stderr.destroy();
    void w.reader.return(undefined).catch(() => {});
  }
  close(): void {
    this.closed = true;
    if (this.worker) this.destroy(this.worker);
  }
  private getWorker(): Worker {
    if (this.closed) throw new Error('Paulina stream is closed');
    if (this.worker) return this.worker;
    if (!this.options.spawnWorker && process.platform !== 'win32') throw new Error('Paulina requires Windows System.Speech');
    const buildId = randomUUID().replaceAll('-', '');
    const child = this.options.spawnWorker?.() ?? spawn(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('../speech/paulina-stream.ps1', import.meta.url)), '-BuildId', buildId],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let fail!: (error: Error) => void;
    const failure = new Promise<never>((_, reject) => { fail = reject; });
    void failure.catch(() => {});
    const reader = packets(child.stdout);
    const w: Worker = { child, reader, failure, fail, ready: undefined! };
    this.worker = w;
    child.stderr.resume();
    child.on('error', () => fail(new Error('Paulina worker could not start')));
    child.stdin.on('error', () => fail(new Error('Paulina worker input closed')));
    child.once('close', () => {
      fail(new Error('Paulina worker exited'));
      if (this.worker === w) this.worker = undefined;
      // Forced termination skips PowerShell finally; remove only this child's unique compiler scratch.
      if (!this.options.spawnWorker) void rm(
        join(fileURLToPath(new URL('../speech', import.meta.url)), `.paulina-build-${buildId}`),
        { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    });
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Paulina worker startup deadline exceeded')), this.options.startupTimeoutMs);
    });
    w.ready = Promise.race([reader.next(), failure, timeout]).then(result => {
      requirePacket(!result.done && result.value.type === 'ready', 'Paulina worker did not announce ready');
      requirePacket(result.value.available && result.value.pcm, result.value.reason ?? 'Paulina PCM unavailable');
      return result.value;
    }).catch(error => { this.destroy(w, error); throw error; }).finally(() => clearTimeout(timer));
    void w.ready.catch(() => {});
    return w;
  }
  async health(): Promise<PaulinaSpeechHealth> {
    try { const { type, ...health } = await this.getWorker().ready; return health; }
    catch (error) {
      return { ...PCM, ...IDENTITY, available: false, pcm: false,
        reason: error instanceof Error ? error.message : 'Paulina unavailable' };
    }
  }
  async stream(text: string, signal: AbortSignal, onEvent: (event: PaulinaSpeechEvent) => Promise<void>): Promise<PaulinaStreamMetrics> {
    const input = validateSpeechText(text);
    signal.throwIfAborted();
    if (this.busy) throw new Error('Paulina stream is busy');
    this.busy = true;
    const began = performance.now(), requestId = randomUUID();
    let owned: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let interrupt!: (error: Error) => void;
    const stopped = new Promise<never>((_, reject) => { interrupt = reject; });
    void stopped.catch(() => {});
    const abort = () => {
      const error = new Error('Paulina speech canceled'); error.name = 'AbortError';
      if (owned) this.destroy(owned, error); interrupt(error);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      owned = this.getWorker();
      const w = owned;
      const wait = <T>(p: Promise<T>): Promise<T> => Promise.race([p, w.failure, stopped]);
      await wait(w.ready);
      const warmupMs = performance.now() - began;
      signal.throwIfAborted();
      timer = setTimeout(() => interrupt(new Error('Paulina synthesis deadline exceeded')), this.options.synthesisTimeoutMs);
      w.child.stdin.write(JSON.stringify({ type: 'speak', requestId, text: input }) + '\n',
        error => { if (error) w.fail(new Error('Paulina request write failed')); });
      let started = false, samples = 0, chunks = 0, phonemes = 0, visemes = 0, firstPcm = 0;
      let lastPhoneme = -1, lastViseme = -1, lastPosition = 0;
      for (;;) {
        const result = await wait(w.reader.next());
        requirePacket(!result.done && this.worker === w && !signal.aborted, 'Paulina worker became stale');
        const e = result.value;
        requirePacket(e.type !== 'ready' && e.requestId === requestId, 'Paulina requestId/order mismatch');
        if (e.type === 'error') throw new Error(`Paulina ${e.code}: ${e.message}`);
        requirePacket(started ? e.type !== 'start' : e.type === 'start', 'Invalid Paulina start ordering');
        if (e.type === 'start') started = true;
        if (e.type === 'audio') {
          requirePacket(e.sequence === chunks && e.startSample === samples, 'Discontinuous Paulina PCM');
          if (chunks === 0) firstPcm = performance.now() - began;
          samples += e.sampleCount; chunks++;
        }
        if (e.type === 'phoneme' || e.type === 'viseme') {
          requirePacket(e.audioPositionMs >= (e.type === 'phoneme' ? lastPhoneme : lastViseme), 'Nonmonotonic native timing');
          lastPosition = Math.max(lastPosition, e.audioPositionMs);
          if (e.type === 'phoneme') { phonemes++; lastPhoneme = e.audioPositionMs; }
          else { visemes++; lastViseme = e.audioPositionMs; }
        }
        if (e.type === 'end') requirePacket(e.totalSamples === samples && e.chunks === chunks
          && e.phonemes === phonemes && e.visemes === visemes && lastPosition <= e.audioDurationMs,
        'Paulina final metrics mismatch');
        // The generator remains parked here: no readline/event queue grows while the consumer is slow.
        await wait(Promise.resolve().then(() => {
          signal.throwIfAborted();
          requirePacket(this.worker === w, 'Paulina worker became stale');
          return onEvent(e);
        }));
        signal.throwIfAborted();
        if (e.type === 'end') return { ...e, warmupMs, firstPcmIncludingWarmupMs: firstPcm,
          firstPcmAfterWarmupMs: firstPcm - warmupMs, elapsedMs: performance.now() - began };
      }
    } catch (error) { if (owned) this.destroy(owned); throw error; }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); this.busy = false; }
  }
}
