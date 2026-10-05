export interface PcmChunk {
  sequence: number;
  sampleRate: number;
  pcm16: Uint8Array;
  sha256: string;
}

export interface PcmChunkProof {
  sequence: number;
  audioSha256: string;
  startMs: number;
  durationMs: number;
}

export interface ScheduledPcm {
  stop(): void;
}

export interface PcmPlaybackBackend {
  nowSeconds(): number;
  resume(): Promise<void>;
  schedule(samples: Float32Array, sampleRate: number, whenSeconds: number, onEnded: () => void): ScheduledPcm;
}

export interface StreamingAudioClock {
  readonly streamId: string;
  readonly durationMs: number | undefined;
  positionMs(): number;
  chunkProof(sequence: number): Readonly<PcmChunkProof> | undefined;
  onEnded(listener: () => void): () => void;
  stop(): void;
}

export class PcmBackpressureError extends Error {
  readonly bufferedMs: number;
  readonly limitMs: number;
  constructor(bufferedMs: number, limitMs: number) {
    super(`PCM buffer would exceed ${limitMs}ms (${bufferedMs}ms); wait for playback before retrying`);
    this.name = 'PcmBackpressureError';
    this.bufferedMs = bufferedMs;
    this.limitMs = limitMs;
  }
}

interface Entry {
  proof: Readonly<PcmChunkProof>;
  when: number;
  until: number;
  ended: boolean;
  handle?: ScheduledPcm;
}

export interface PcmStreamOptions {
  streamId: string;
  sampleRate?: number;
  startDelayMs?: number;
  maxBufferedMs?: number;
  maxChunkMs?: number;
  digest?: (bytes: Uint8Array) => Promise<string>;
  onError?: (error: Error) => void;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function browserPcmBackend(context: AudioContext): PcmPlaybackBackend {
  return {
    nowSeconds: () => context.currentTime,
    resume: async () => {
      if (context.state === 'closed') throw new Error('Audio context is closed');
      await context.resume();
      if (context.state !== 'running') throw new Error('Audio playback was not allowed to start');
    },
    schedule(samples, sampleRate, whenSeconds, onEnded) {
      const buffer = context.createBuffer(1, samples.length, sampleRate);
      buffer.getChannelData(0).set(samples);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => { source.disconnect(); onEnded(); };
      try { source.start(whenSeconds); }
      catch (error) { source.disconnect(); throw error; }
      return { stop: () => source.stop() };
    },
  };
}

/** Clock advances only through the exact PCM scheduled for this stream, including underrun pauses. */
export class PcmStreamPlayer implements StreamingAudioClock {
  readonly streamId: string;
  private readonly sampleRate: number;
  private readonly startDelaySeconds: number;
  private readonly maxBufferedMs: number;
  private readonly maxChunkMs: number;
  private readonly digest: (bytes: Uint8Array) => Promise<string>;
  private readonly onError: (error: Error) => void;
  private readonly entries: Entry[] = [];
  private readonly proofs = new Map<number, Readonly<PcmChunkProof>>();
  private readonly listeners = new Set<() => void>();
  private samples = 0;
  private nextSequence = 0;
  private finishedMs = 0;
  private lastPositionMs = 0;
  private failure?: Error;
  private lastClockSeconds = 0;
  private busy = false;
  private state: 'open' | 'sealed' | 'ended' | 'stopped' | 'failed' = 'open';
  private generation = 0;
  private readonly backend: PcmPlaybackBackend;

  constructor(backend: PcmPlaybackBackend, options: PcmStreamOptions) {
    this.backend = backend;
    if (typeof options.streamId !== 'string' || !options.streamId.trim()) throw new Error('PCM streamId is required');
    this.streamId = options.streamId;
    this.sampleRate = options.sampleRate ?? 16000;
    this.startDelaySeconds = (options.startDelayMs ?? 60) / 1000;
    this.maxBufferedMs = options.maxBufferedMs ?? 1500;
    this.maxChunkMs = options.maxChunkMs ?? 500;
    if (!Number.isInteger(this.sampleRate) || this.sampleRate < 8000 || this.sampleRate > 48000) {
      throw new Error('PCM sample rate must be an integer within 8000..48000');
    }
    for (const [name, value] of [
      ['startDelaySeconds', this.startDelaySeconds], ['maxBufferedMs', this.maxBufferedMs], ['maxChunkMs', this.maxChunkMs],
    ] as const) {
      if (!Number.isFinite(value) || value < 0 || (name !== 'startDelaySeconds' && value === 0)) {
        throw new Error(`${name} must be finite and ${name === 'startDelaySeconds' ? 'nonnegative' : 'positive'}`);
      }
    }
    if (this.maxChunkMs > this.maxBufferedMs) throw new Error('PCM chunk limit cannot exceed the buffer limit');
    this.digest = options.digest ?? sha256;
    this.onError = options.onError ?? (error => console.error('PCM streaming playback failed:', error));
  }

  get durationMs(): number | undefined {
    return this.state === 'open' ? undefined : this.samples / this.sampleRate * 1000;
  }

  chunkProof(sequence: number): Readonly<PcmChunkProof> | undefined {
    return this.proofs.get(sequence);
  }

  private now(): number {
    const value = this.backend.nowSeconds();
    if (!Number.isFinite(value) || value < this.lastClockSeconds || value < 0) throw new Error('PCM playback clock must be finite and monotonic');
    this.lastClockSeconds = value;
    return value;
  }

  positionMs(): number {
    if (this.failure) throw this.failure;
    if (this.state === 'stopped') return this.finishedMs;
    const now = this.now();
    let position = this.finishedMs;
    for (const entry of this.entries) {
      if (now < entry.when) break;
      position = entry.proof.startMs + Math.min(entry.proof.durationMs, (now - entry.when) * 1000);
      if (now < entry.until) break;
    }
    this.lastPositionMs = position;
    return position;
  }

  async enqueue(chunk: PcmChunk): Promise<Readonly<PcmChunkProof>> {
    if (this.state !== 'open') throw new Error('PCM stream is no longer accepting audio');
    if (this.busy) throw new Error('Await the previous PCM enqueue before sending another chunk');
    if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence !== this.nextSequence) throw new Error('PCM sequence is out of order');
    if (chunk.sampleRate !== this.sampleRate) throw new Error('PCM sample rate mismatch');
    if (!(chunk.pcm16 instanceof Uint8Array) || !chunk.pcm16.length || chunk.pcm16.length % 2) throw new Error('PCM must contain complete, nonempty signed 16-bit samples');
    if (!/^[a-f0-9]{64}$/.test(chunk.sha256)) throw new Error('PCM SHA-256 must be a lowercase digest');
    const bytes = new Uint8Array(chunk.pcm16);
    const count = bytes.length / 2;
    const durationMs = count / this.sampleRate * 1000;
    if (durationMs > this.maxChunkMs) throw new Error(`PCM chunk exceeds ${this.maxChunkMs}ms`);
    const bufferedMs = this.samples / this.sampleRate * 1000 - this.positionMs() + durationMs;
    if (bufferedMs > this.maxBufferedMs + 0.001) throw new PcmBackpressureError(bufferedMs, this.maxBufferedMs);
    const generation = this.generation;
    this.busy = true;
    try {
      if (await this.digest(bytes) !== chunk.sha256) throw new Error('PCM digest mismatch; audio was not scheduled');
      if (generation !== this.generation) throw new Error('PCM enqueue was cancelled');
      try { await this.backend.resume(); }
      catch (error) { this.fail(error); throw error; }
      if (generation !== this.generation) throw new Error('PCM enqueue was cancelled');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const decoded = new Float32Array(count);
      for (let index = 0; index < count; index++) decoded[index] = view.getInt16(index * 2, true) / 32768;
      const now = this.now();
      const previous = this.entries.at(-1);
      const when = previous && previous.until >= now ? previous.until : now + this.startDelaySeconds;
      const proof = Object.freeze({
        sequence: chunk.sequence, audioSha256: chunk.sha256,
        startMs: this.samples / this.sampleRate * 1000, durationMs,
      });
      const entry: Entry = { proof, when, until: when + count / this.sampleRate, ended: false };
      this.entries.push(entry);
      this.proofs.set(proof.sequence, proof);
      this.samples += count;
      this.nextSequence++;
      try {
        entry.handle = this.backend.schedule(decoded, this.sampleRate, when, () => this.ended(entry, generation));
      } catch (error) {
        this.fail(error);
        throw error;
      }
      return proof;
    } finally {
      this.busy = false;
    }
  }

  seal(): void {
    if (this.state !== 'open') throw new Error('PCM stream is not open');
    if (this.busy) throw new Error('Await pending PCM audio before sealing');
    if (!this.samples) throw new Error('Cannot seal an empty PCM stream');
    this.state = 'sealed';
    this.completeIfEnded();
  }

  onEnded(listener: () => void): () => void {
    if (this.state === 'ended') listener(); else this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    if (['ended', 'stopped', 'failed'].includes(this.state)) return;
    let positionError: Error | undefined;
    try { this.finishedMs = this.positionMs(); }
    catch (error) { this.finishedMs = this.lastPositionMs; positionError = asError(error); }
    this.state = 'stopped';
    this.generation++;
    this.stopEntries();
    this.listeners.clear();
    if (positionError) this.report(positionError);
  }

  private fail(value: unknown): void {
    this.failure = asError(value);
    this.finishedMs = this.lastPositionMs;
    this.state = 'failed';
    this.generation++;
    this.stopEntries();
    this.listeners.clear();
    this.report(this.failure);
  }

  private report(error: Error): void {
    try { this.onError(error); }
    catch (callbackError) { console.error('PCM error listener failed:', callbackError); }
  }

  private stopEntries(): void {
    for (const entry of this.entries) {
      if (!entry.ended) {
        entry.ended = true;
        try { entry.handle?.stop(); } catch (error) { this.report(asError(error)); }
      }
    }
  }

  private ended(entry: Entry, generation: number): void {
    if (generation !== this.generation || entry.ended) return;
    entry.ended = true;
    while (this.entries[0]?.ended) {
      const finished = this.entries.shift()!;
      this.finishedMs = finished.proof.startMs + finished.proof.durationMs;
    }
    while (this.proofs.size > 256) this.proofs.delete(this.proofs.keys().next().value!);
    this.completeIfEnded();
  }

  private completeIfEnded(): void {
    if (this.state !== 'sealed' || this.entries.length) return;
    this.state = 'ended';
    for (const listener of [...this.listeners]) {
      try { listener(); } catch (error) { this.report(asError(error)); }
    }
    this.listeners.clear();
  }
}
