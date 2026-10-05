import { CharacterEngine, MOUTH_POSE_KEYS, REST_MOUTH, validateCharacterIdentity, validateCharacterTimeline } from './characterEngine.ts';
import type { CharacterFrame, CharacterIdentity, CharacterTimeline, MouthPose } from './characterEngine.ts';

export type MouthChannel = keyof MouthPose;
export type TimingSource = CharacterTimeline['timingSource'];

/** What the renderer's actual rig can show. Channels not listed are never presented as articulated. */
export interface RigCapabilities {
  rigRevision: string;
  referenceSha256: string;
  channels: readonly MouthChannel[];
}

/** Playback clock for the exact audio buffer being heard; position is the only timing authority. */
export interface CharacterAudioClock {
  readonly audioSha256: string;
  readonly durationMs: number;
  positionMs(): number;
  onEnded(listener: () => void): () => void;
}

export interface CharacterSessionFrame extends CharacterFrame {
  generation: number;
  supportedChannels: readonly MouthChannel[];
  suppressedChannels: readonly MouthChannel[];
}

export interface CharacterRenderer {
  readonly id: string;
  readonly capabilities: RigCapabilities;
  render(frame: CharacterSessionFrame): void;
}

export interface FrameScheduler {
  request(callback: () => void): unknown;
  cancel(handle: unknown): void;
}

export type PlaybackStatus = 'playing' | 'completed' | 'cancelled' | 'replaced' | 'failed';

export interface CharacterPlayback {
  readonly generation: number;
  readonly timingSource: TimingSource;
  readonly suppressedChannels: readonly MouthChannel[];
  readonly done: Promise<PlaybackStatus>;
  status(): PlaybackStatus;
  error(): Error | undefined;
  cancel(): void;
}

export interface CharacterSessionOptions {
  /** 'estimated' timing must be opted into explicitly. */
  acceptedTimingSources?: readonly TimingSource[];
  /** 'reject' (default) refuses timelines needing channels the rig lacks; 'suppress' zeroes and reports them. */
  unsupportedArticulation?: 'reject' | 'suppress';
  durationToleranceMs?: number;
  transitionMs?: number;
}

const TIMING_SOURCES: readonly TimingSource[] = ['forced-alignment', 'tts-phonemes', 'estimated'];
const CAPABILITY_KEYS = ['rigRevision', 'referenceSha256', 'channels'];

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function validateRigCapabilities(capabilities: RigCapabilities): Readonly<RigCapabilities> {
  if (!capabilities || typeof capabilities !== 'object') throw new Error('Renderer must declare rig capabilities');
  for (const key of Object.keys(capabilities)) {
    if (!CAPABILITY_KEYS.includes(key)) throw new Error(`Unknown rig capability: ${key}`);
  }
  if (typeof capabilities.rigRevision !== 'string' || !capabilities.rigRevision.trim()) throw new Error('Missing rig capability rigRevision');
  if (!isDigest(capabilities.referenceSha256)) throw new Error('Rig referenceSha256 must be a lowercase SHA-256 digest');
  if (!Array.isArray(capabilities.channels)) throw new Error('Rig channels must be an array');
  const seen = new Set<string>();
  for (const channel of capabilities.channels) {
    if (!(MOUTH_POSE_KEYS as readonly string[]).includes(channel)) throw new Error(`Unknown mouth channel capability: ${String(channel)}`);
    if (seen.has(channel)) throw new Error(`Duplicate mouth channel capability: ${channel}`);
    seen.add(channel);
  }
  return Object.freeze({ ...capabilities, channels: Object.freeze([...capabilities.channels]) });
}

interface PlaybackState {
  generation: number;
  status: PlaybackStatus;
  error?: Error;
  engine: CharacterEngine;
  timeline: CharacterTimeline;
  clock: CharacterAudioClock;
  suppressed: readonly MouthChannel[];
  handle?: unknown;
  scheduled: boolean;
  unsubscribe?: () => void;
  resolve: (status: PlaybackStatus) => void;
}

export class CharacterSession {
  readonly identity: Readonly<CharacterIdentity>;
  readonly capabilities: Readonly<RigCapabilities>;
  private readonly acceptedTimingSources: readonly TimingSource[];
  private readonly unsupportedArticulation: 'reject' | 'suppress';
  private readonly durationToleranceMs: number;
  private readonly transitionMs: number;
  private generation = 0;
  private active?: PlaybackState;
  private disposed = false;
  private readonly renderer: CharacterRenderer;
  private readonly scheduler: FrameScheduler;

  constructor(
    identity: CharacterIdentity,
    renderer: CharacterRenderer,
    scheduler: FrameScheduler,
    options: CharacterSessionOptions = {},
  ) {
    this.renderer = renderer;
    this.scheduler = scheduler;
    validateCharacterIdentity(identity);
    this.identity = Object.freeze({ ...identity });
    this.capabilities = validateRigCapabilities(renderer.capabilities);
    if (this.capabilities.rigRevision !== identity.rigRevision || this.capabilities.referenceSha256 !== identity.referenceSha256) {
      throw new Error('Renderer rig does not match character reference/rig revision');
    }
    const accepted = options.acceptedTimingSources ?? ['forced-alignment', 'tts-phonemes'];
    if (!accepted.length) throw new Error('At least one timing source must be accepted');
    for (const source of accepted) if (!TIMING_SOURCES.includes(source)) throw new Error(`Unknown timing source: ${String(source)}`);
    this.acceptedTimingSources = Object.freeze([...accepted]);
    const mode = options.unsupportedArticulation ?? 'reject';
    if (mode !== 'reject' && mode !== 'suppress') throw new Error(`Unknown unsupported-articulation mode: ${String(mode)}`);
    this.unsupportedArticulation = mode;
    this.durationToleranceMs = options.durationToleranceMs ?? 50;
    this.transitionMs = options.transitionMs ?? 40;
    for (const [name, value] of [['durationToleranceMs', this.durationToleranceMs], ['transitionMs', this.transitionMs]] as const) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and nonnegative`);
    }
  }

  get current(): CharacterPlayback | undefined {
    return this.active?.status === 'playing' ? this.handleFor(this.active) : undefined;
  }

  /** Validates everything before touching the active playback, so a rejected replacement leaves it running. */
  play(timeline: CharacterTimeline, clock: CharacterAudioClock): CharacterPlayback {
    if (this.disposed) throw new Error('Character session is disposed');
    validateCharacterTimeline(timeline);
    if (!this.acceptedTimingSources.includes(timeline.timingSource)) {
      throw new Error(`Timing source "${timeline.timingSource}" is not accepted by this session`);
    }
    if (!clock || typeof clock.positionMs !== 'function' || typeof clock.onEnded !== 'function') throw new Error('Audio clock is incomplete');
    if (!Number.isFinite(clock.durationMs) || clock.durationMs <= 0) throw new Error('Audio clock duration must be finite and positive');
    if (!isDigest(clock.audioSha256)) throw new Error('Audio clock audioSha256 must be a lowercase SHA-256 digest');
    if (clock.audioSha256 !== timeline.audioSha256) throw new Error('Audio digest mismatch; timeline was not built for this audio');
    if (Math.abs(clock.durationMs - timeline.durationMs) > this.durationToleranceMs) {
      throw new Error(`Audio duration mismatch: clock ${clock.durationMs}ms vs timeline ${timeline.durationMs}ms`);
    }
    const missing = MOUTH_POSE_KEYS.filter(key => !this.capabilities.channels.includes(key)
      && timeline.cues.some(cue => cue.pose[key] > 0));
    if (missing.length && this.unsupportedArticulation === 'reject') {
      throw new Error(`Rig ${this.capabilities.rigRevision} cannot articulate: ${missing.join(', ')}`);
    }
    const engine = new CharacterEngine(this.identity);
    engine.load(timeline);

    if (this.active) this.finish(this.active, 'replaced');
    let resolve!: (status: PlaybackStatus) => void;
    const done = new Promise<PlaybackStatus>(res => { resolve = res; });
    const state: PlaybackState = {
      generation: ++this.generation, status: 'playing', engine,
      timeline: { ...timeline }, clock, suppressed: Object.freeze(missing), scheduled: false, resolve,
    };
    this.active = state;
    const handle = this.handleFor(state, done);
    try {
      const unsubscribe = clock.onEnded(() => { if (this.isLive(state)) this.finish(state, 'completed'); });
      if (state.status === 'playing') state.unsubscribe = unsubscribe; else unsubscribe();
    } catch (error) {
      this.finish(state, 'failed', error);
    }
    this.schedule(state);
    return handle;
  }

  cancel(): void {
    if (this.active) this.finish(this.active, 'cancelled');
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  private readonly handles = new WeakMap<PlaybackState, CharacterPlayback>();

  private handleFor(state: PlaybackState, done?: Promise<PlaybackStatus>): CharacterPlayback {
    const existing = this.handles.get(state);
    if (existing) return existing;
    const playback: CharacterPlayback = Object.freeze({
      generation: state.generation,
      timingSource: state.timeline.timingSource,
      suppressedChannels: state.suppressed,
      done: done!,
      status: () => state.status,
      error: () => state.error,
      cancel: () => this.finish(state, 'cancelled'),
    });
    this.handles.set(state, playback);
    return playback;
  }

  private isLive(state: PlaybackState): boolean {
    return this.active === state && state.status === 'playing';
  }

  private schedule(state: PlaybackState): void {
    if (!this.isLive(state) || state.scheduled) return;
    state.scheduled = true;
    try {
      state.handle = this.scheduler.request(() => this.tick(state));
    } catch (error) {
      state.scheduled = false;
      this.finish(state, 'failed', error);
    }
  }

  private tick(state: PlaybackState): void {
    if (!this.isLive(state)) return;
    state.scheduled = false;
    state.handle = undefined;
    try {
      const positionMs = state.clock.positionMs();
      if (!Number.isFinite(positionMs) || positionMs < 0) throw new Error('Audio clock position must be finite and nonnegative');
      if (positionMs >= state.timeline.durationMs) {
        this.finish(state, 'completed');
        return;
      }
      this.renderer.render(this.frame(state, state.engine.sample(positionMs, this.transitionMs)));
    } catch (error) {
      this.finish(state, 'failed', error);
      return;
    }
    this.schedule(state);
  }

  private frame(state: PlaybackState, frame: CharacterFrame): CharacterSessionFrame {
    const mouth = { ...frame.mouth };
    for (const key of MOUTH_POSE_KEYS) if (!this.capabilities.channels.includes(key)) mouth[key] = 0;
    return {
      ...frame, mouth, generation: state.generation,
      supportedChannels: this.capabilities.channels, suppressedChannels: state.suppressed,
    };
  }

  private safePosition(state: PlaybackState): number {
    try {
      const value = state.clock.positionMs();
      return Number.isFinite(value) && value >= 0 ? Math.min(value, state.timeline.durationMs) : 0;
    } catch {
      return 0;
    }
  }

  private finish(state: PlaybackState, status: Exclude<PlaybackStatus, 'playing'>, error?: unknown): void {
    if (state.status !== 'playing') return;
    state.status = status;
    if (error !== undefined) state.error = error instanceof Error ? error : new Error(String(error));
    if (state.scheduled) {
      state.scheduled = false;
      try { this.scheduler.cancel(state.handle); } catch { /* the generation check still blocks the stale tick */ }
    }
    try { state.unsubscribe?.(); } catch { /* the generation check still blocks stale ended events */ }
    state.unsubscribe = undefined;
    state.engine.interrupt();
    if (status !== 'replaced') {
      try {
        this.renderer.render(this.frame(state, {
          identity: this.identity, audioMs: this.safePosition(state), phoneme: null, mouth: { ...REST_MOUTH },
          timingSource: state.timeline.timingSource,
        }));
      } catch { /* a renderer failure must not mask the terminal status */ }
    }
    state.resolve(status);
  }
}
