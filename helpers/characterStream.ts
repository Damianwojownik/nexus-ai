import { CharacterEngine, MOUTH_POSE_KEYS, REST_MOUTH, sameCharacter, validateCharacterIdentity, validateCharacterTimeline } from './characterEngine.ts';
import type { CharacterIdentity, CharacterTimeline, MouthPose } from './characterEngine.ts';
import { validateRigCapabilities } from './characterSession.ts';
import type { CharacterRenderer, CharacterSessionFrame, FrameScheduler, MouthChannel, RigCapabilities, TimingSource } from './characterSession.ts';
import type { StreamingAudioClock } from './pcmStream.ts';

export interface StreamingCharacterRenderer extends CharacterRenderer {
  mode: 'articulatory-rig' | 'neural-stream' | 'batch-film';
}

export type CharacterStreamStatus = 'buffering' | 'playing' | 'completed' | 'cancelled' | 'replaced' | 'failed';

export interface CharacterStreamPlayback {
  readonly generation: number;
  readonly streamId: string;
  readonly done: Promise<CharacterStreamStatus>;
  append(sequence: number, timeline: CharacterTimeline): void;
  seal(): void;
  cancel(): void;
  status(): CharacterStreamStatus;
  error(): Error | undefined;
}

export interface CharacterStreamOptions {
  acceptedTimingSources?: readonly TimingSource[];
  unsupportedArticulation?: 'reject' | 'suppress';
  durationToleranceMs?: number;
  transitionMs?: number;
  maxQueuedMs?: number;
  onError?: (error: Error) => void;
}

interface Segment {
  startMs: number;
  endMs: number;
  engine: CharacterEngine;
  suppressed: readonly MouthChannel[];
}

interface StreamState {
  generation: number;
  streamId: string;
  clock: StreamingAudioClock;
  status: CharacterStreamStatus;
  nextSequence: number;
  endMs: number;
  lastPositionMs: number;
  tail: Readonly<MouthPose>;
  segments: Segment[];
  sealed: boolean;
  error?: Error;
  handle?: unknown;
  scheduled: boolean;
  unsubscribe?: () => void;
  resolve: (status: CharacterStreamStatus) => void;
  playback: CharacterStreamPlayback;
}

const live = (state: StreamState) => state.status === 'buffering' || state.status === 'playing';
const timingSources: readonly TimingSource[] = ['forced-alignment', 'tts-phonemes', 'estimated'];

/** Incremental control plane; pixel quality and model throughput still belong to the injected renderer. */
export class CharacterStreamSession {
  readonly identity: Readonly<CharacterIdentity>;
  readonly capabilities: Readonly<RigCapabilities>;
  private readonly renderer: StreamingCharacterRenderer;
  private readonly scheduler: FrameScheduler;
  private readonly options: Required<CharacterStreamOptions>;
  private generation = 0;
  private active?: StreamState;
  private disposed = false;

  constructor(identity: CharacterIdentity, renderer: StreamingCharacterRenderer, scheduler: FrameScheduler, options: CharacterStreamOptions = {}) {
    validateCharacterIdentity(identity);
    this.identity = Object.freeze({ ...identity });
    this.renderer = renderer;
    this.scheduler = scheduler;
    if (!['articulatory-rig', 'neural-stream'].includes(renderer.mode)) throw new Error('Batch movies cannot provide a realtime character session');
    this.capabilities = validateRigCapabilities(renderer.capabilities);
    if (this.capabilities.referenceSha256 !== identity.referenceSha256 || this.capabilities.rigRevision !== identity.rigRevision) {
      throw new Error('Streaming renderer does not match the pinned character reference/rig');
    }
    this.options = {
      acceptedTimingSources: Object.freeze([...(options.acceptedTimingSources ?? ['forced-alignment', 'tts-phonemes'])]),
      unsupportedArticulation: options.unsupportedArticulation ?? 'reject',
      durationToleranceMs: options.durationToleranceMs ?? 1,
      transitionMs: options.transitionMs ?? 40,
      maxQueuedMs: options.maxQueuedMs ?? 1500,
      onError: options.onError ?? (error => console.error('Character streaming failed:', error)),
    };
    if (!this.options.acceptedTimingSources.length || this.options.acceptedTimingSources.some(source => !timingSources.includes(source))) {
      throw new Error('Streaming timing sources must be explicit and supported');
    }
    if (!['reject', 'suppress'].includes(this.options.unsupportedArticulation)) throw new Error('Unknown articulation suppression mode');
    for (const key of ['durationToleranceMs', 'transitionMs', 'maxQueuedMs'] as const) {
      const value = this.options[key];
      if (!Number.isFinite(value) || value < 0 || (key === 'maxQueuedMs' && value === 0)) throw new Error(`Invalid streaming ${key}`);
    }
  }

  get current(): CharacterStreamPlayback | undefined {
    return this.active && live(this.active) ? this.active.playback : undefined;
  }

  begin(clock: StreamingAudioClock): CharacterStreamPlayback {
    if (this.disposed) throw new Error('Streaming character session is disposed');
    if (!clock || !clock.streamId?.trim() || typeof clock.positionMs !== 'function'
      || typeof clock.chunkProof !== 'function' || typeof clock.onEnded !== 'function' || typeof clock.stop !== 'function') {
      throw new Error('Streaming audio clock is incomplete');
    }
    const position = clock.positionMs();
    if (!Number.isFinite(position) || position < 0 || position > this.options.durationToleranceMs) throw new Error('Begin the character stream before its audio starts');
    if (this.active) this.finish(this.active, 'replaced');
    let resolve!: (status: CharacterStreamStatus) => void;
    const done = new Promise<CharacterStreamStatus>(value => { resolve = value; });
    const state: StreamState = {
      generation: ++this.generation, streamId: clock.streamId, clock,
      status: 'buffering', nextSequence: 0, endMs: 0, lastPositionMs: position,
      tail: REST_MOUTH, segments: [], sealed: false, scheduled: false, resolve,
      playback: Object.freeze({
        generation: this.generation, streamId: clock.streamId, done,
        append: (sequence: number, timeline: CharacterTimeline) => this.append(state, sequence, timeline),
        seal: () => this.seal(state), cancel: () => this.finish(state, 'cancelled'),
        status: () => state.status, error: () => state.error,
      }),
    };
    this.active = state;
    try {
      const unsubscribe = clock.onEnded(() => {
        if (!this.isLive(state)) return;
        if (!state.sealed || !state.endMs || clock.durationMs === undefined
          || Math.abs(clock.durationMs - state.endMs) > this.options.durationToleranceMs) {
          this.finish(state, 'failed', new Error('Audio ended without a complete matching articulation stream'));
        } else this.finish(state, 'completed');
      });
      if (live(state)) state.unsubscribe = unsubscribe; else unsubscribe();
    } catch (error) {
      this.finish(state, 'failed', error);
    }
    this.schedule(state);
    return state.playback;
  }

  dispose(): void {
    if (this.active) this.finish(this.active, 'cancelled');
    this.disposed = true;
  }

  private isLive(state: StreamState): boolean {
    return this.active === state && live(state);
  }

  private position(state: StreamState): number {
    if (state.clock.streamId !== state.streamId) throw new Error('Audio stream identity changed during playback');
    const value = state.clock.positionMs();
    if (!Number.isFinite(value) || value < state.lastPositionMs || value < 0) throw new Error('Streaming audio clock must be finite and monotonic');
    state.lastPositionMs = value;
    return value;
  }

  private append(state: StreamState, sequence: number, timeline: CharacterTimeline): void {
    if (!this.isLive(state) || state.sealed) throw new Error('Articulation stream is not accepting chunks');
    validateCharacterTimeline(timeline);
    if (!sameCharacter(this.identity, timeline.identity)) throw new Error('Streaming character identity mismatch');
    if (!this.options.acceptedTimingSources.includes(timeline.timingSource)) throw new Error(`Timing source "${timeline.timingSource}" is not accepted`);
    if (!Number.isSafeInteger(sequence) || sequence !== state.nextSequence) throw new Error('Articulation chunk sequence is out of order');
    const proof = state.clock.chunkProof(sequence);
    if (!proof || proof.sequence !== sequence || proof.audioSha256 !== timeline.audioSha256) throw new Error('Articulation chunk does not match the scheduled PCM digest');
    if (!Number.isFinite(proof.startMs) || !Number.isFinite(proof.durationMs) || proof.durationMs <= 0
      || Math.abs(proof.startMs - state.endMs) > this.options.durationToleranceMs
      || Math.abs(proof.durationMs - timeline.durationMs) > this.options.durationToleranceMs) {
      throw new Error('Articulation chunk does not match the PCM position/duration');
    }
    const position = this.position(state);
    if (position > proof.startMs + this.options.durationToleranceMs) throw new Error('Articulation arrived after its audio started');
    if (proof.startMs + proof.durationMs - position > this.options.maxQueuedMs + this.options.durationToleranceMs) {
      throw new Error('Streaming articulation buffer is full; wait for playback');
    }
    const missing = MOUTH_POSE_KEYS.filter(key => !this.capabilities.channels.includes(key) && timeline.cues.some(cue => cue.pose[key] > 0));
    if (missing.length && this.options.unsupportedArticulation === 'reject') throw new Error(`Streaming rig cannot articulate: ${missing.join(', ')}`);
    const engine = new CharacterEngine(this.identity);
    engine.load(timeline, state.tail);
    const last = timeline.cues.at(-1);
    const segment: Segment = {
      startMs: proof.startMs, endMs: proof.startMs + proof.durationMs,
      engine, suppressed: Object.freeze(missing),
    };
    state.segments.push(segment);
    state.tail = last?.endMs === timeline.durationMs ? { ...last.pose } : REST_MOUTH;
    state.endMs = segment.endMs;
    state.nextSequence++;
  }

  private seal(state: StreamState): void {
    if (!this.isLive(state) || state.sealed || !state.nextSequence) throw new Error('Cannot seal an inactive, empty or sealed articulation stream');
    const duration = state.clock.durationMs;
    if (duration !== undefined && Math.abs(duration - state.endMs) > this.options.durationToleranceMs) throw new Error('Complete audio/articulation duration mismatch');
    state.sealed = true;
  }

  private schedule(state: StreamState): void {
    if (!this.isLive(state) || state.scheduled) return;
    state.scheduled = true;
    try { state.handle = this.scheduler.request(() => this.tick(state)); }
    catch (error) { state.scheduled = false; this.finish(state, 'failed', error); }
  }

  private tick(state: StreamState): void {
    if (!this.isLive(state)) return;
    state.scheduled = false;
    state.handle = undefined;
    try {
      const position = this.position(state);
      if (state.sealed && position >= state.endMs) { this.finish(state, 'completed'); return; }
      while (state.segments[0] && position >= state.segments[0].endMs) state.segments.shift();
      const segment = state.segments[0];
      if (segment && position >= segment.startMs) {
        state.status = 'playing';
        const frame = segment.engine.sample(position - segment.startMs, this.options.transitionMs);
        const mouth = { ...frame.mouth };
        for (const key of MOUTH_POSE_KEYS) if (!this.capabilities.channels.includes(key)) mouth[key] = 0;
        this.renderer.render({
          ...frame, mouth, audioMs: position, generation: state.generation,
          supportedChannels: this.capabilities.channels, suppressedChannels: segment.suppressed,
        });
      } else {
        state.status = 'buffering';
        state.tail = REST_MOUTH;
        this.renderer.render(this.rest(state));
      }
    } catch (error) { this.finish(state, 'failed', error); return; }
    this.schedule(state);
  }

  private rest(state: StreamState): CharacterSessionFrame {
    return {
      identity: this.identity, audioMs: state.lastPositionMs, phoneme: null,
      mouth: { ...REST_MOUTH }, timingSource: null, generation: state.generation,
      supportedChannels: this.capabilities.channels, suppressedChannels: [],
    };
  }

  private finish(state: StreamState, status: Exclude<CharacterStreamStatus, 'playing' | 'buffering'>, value?: unknown): void {
    if (!live(state)) return;
    state.status = status;
    const report = (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      state.error ??= failure;
      if (state.status === 'completed') state.status = 'failed';
      try { this.options.onError(failure); }
      catch (callbackError) { console.error('Character stream error listener failed:', callbackError); }
    };
    if (value !== undefined) report(value);
    if (state.scheduled) {
      state.scheduled = false;
      try { this.scheduler.cancel(state.handle); } catch (error) { report(error); }
    }
    try { state.unsubscribe?.(); } catch (error) { report(error); }
    try { state.clock.stop(); } catch (error) { report(error); }
    for (const segment of state.segments) segment.engine.interrupt();
    state.segments = [];
    if (status !== 'replaced') {
      try { this.renderer.render(this.rest(state)); } catch (error) { report(error); }
    }
    state.resolve(state.status);
  }
}
