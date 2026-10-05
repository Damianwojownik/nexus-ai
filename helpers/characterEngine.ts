export interface CharacterIdentity {
  id: string;
  revision: string;
  referenceSha256: string;
  rigRevision: string;
}

export interface MouthPose {
  jaw: number;
  width: number;
  rounding: number;
  lipClosure: number;
  tongueTip: number;
  tongueBack: number;
  teethContact: number;
}

export interface ArticulationCue {
  phoneme: string;
  startMs: number;
  endMs: number;
  pose: MouthPose;
}

export interface CharacterTimeline {
  identity: CharacterIdentity;
  audioSha256: string;
  language: 'pl' | 'en' | 'de';
  timingSource: 'forced-alignment' | 'tts-phonemes' | 'estimated';
  durationMs: number;
  cues: readonly ArticulationCue[];
}

export const REST_MOUTH: Readonly<MouthPose> = Object.freeze({
  jaw: 0, width: 0, rounding: 0, lipClosure: 0,
  tongueTip: 0, tongueBack: 0, teethContact: 0,
});

export const MOUTH_POSE_KEYS: readonly (keyof MouthPose)[] = Object.freeze([
  'jaw', 'width', 'rounding', 'lipClosure', 'tongueTip', 'tongueBack', 'teethContact',
] as const);
const poseKeys = MOUTH_POSE_KEYS;

function nonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and nonnegative`);
}

function hash(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
}

export function validateCharacterIdentity(identity: CharacterIdentity): void {
  for (const key of ['id', 'revision', 'rigRevision'] as const) {
    if (typeof identity[key] !== 'string' || !identity[key].trim()) throw new Error(`Missing character ${key}`);
  }
  hash(identity.referenceSha256, 'referenceSha256');
}

export function sameCharacter(left: CharacterIdentity, right: CharacterIdentity): boolean {
  return left.id === right.id && left.revision === right.revision
    && left.referenceSha256 === right.referenceSha256 && left.rigRevision === right.rigRevision;
}

export function validateMouthPose(pose: Readonly<MouthPose>): void {
  for (const key of poseKeys) {
    const value = pose[key];
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Mouth ${key} must be within 0..1`);
  }
}

export function validateCharacterTimeline(timeline: CharacterTimeline): void {
  validateCharacterIdentity(timeline.identity);
  hash(timeline.audioSha256, 'audioSha256');
  if (!['pl', 'en', 'de'].includes(timeline.language)) throw new Error('Unsupported articulation language');
  if (!['forced-alignment', 'tts-phonemes', 'estimated'].includes(timeline.timingSource)) throw new Error('Unknown timing source');
  nonnegative(timeline.durationMs, 'durationMs');
  if (!timeline.durationMs) throw new Error('Audio duration must be positive');
  let endMs = 0;
  for (const cue of timeline.cues) {
    nonnegative(cue.startMs, 'cue.startMs');
    nonnegative(cue.endMs, 'cue.endMs');
    if (!cue.phoneme.trim() || cue.startMs < endMs || cue.endMs <= cue.startMs || cue.endMs > timeline.durationMs) {
      throw new Error('Phoneme cues must be ordered, non-overlapping and within audio duration');
    }
    validateMouthPose(cue.pose);
    endMs = cue.endMs;
  }
}

export interface CharacterFrame {
  identity: Readonly<CharacterIdentity>;
  audioMs: number;
  phoneme: string | null;
  mouth: MouthPose;
  timingSource: CharacterTimeline['timingSource'] | null;
}

export class CharacterEngine {
  readonly identity: Readonly<CharacterIdentity>;
  private timeline?: CharacterTimeline;
  private initialPose: Readonly<MouthPose> = REST_MOUTH;

  constructor(identity: CharacterIdentity) {
    validateCharacterIdentity(identity);
    this.identity = Object.freeze({ ...identity });
  }

  load(timeline: CharacterTimeline, initialPose: Readonly<MouthPose> = REST_MOUTH): void {
    validateCharacterTimeline(timeline);
    validateMouthPose(initialPose);
    if (!sameCharacter(this.identity, timeline.identity)) throw new Error('Character identity mismatch; timeline was not loaded');
    this.initialPose = { ...initialPose };
    this.timeline = {
      ...timeline, identity: { ...timeline.identity },
      cues: timeline.cues.map(cue => ({ ...cue, pose: { ...cue.pose } })),
    };
  }

  interrupt(): void {
    this.timeline = undefined;
    this.initialPose = REST_MOUTH;
  }

  sample(audioMs: number, transitionMs = 40): CharacterFrame {
    nonnegative(audioMs, 'audioMs');
    nonnegative(transitionMs, 'transitionMs');
    const timeline = this.timeline;
    const frame: CharacterFrame = {
      identity: this.identity, audioMs, phoneme: null, mouth: { ...REST_MOUTH },
      timingSource: timeline?.timingSource ?? null,
    };
    if (!timeline || audioMs >= timeline.durationMs) return frame;
    const index = timeline.cues.findIndex(cue => audioMs >= cue.startMs && audioMs < cue.endMs);
    if (index < 0) return frame;
    const cue = timeline.cues[index];
    const previous = timeline.cues[index - 1];
    const from = previous?.endMs === cue.startMs ? previous.pose
      : index === 0 && cue.startMs === 0 ? this.initialPose : REST_MOUTH;
    const windowMs = Math.min(transitionMs, (cue.endMs - cue.startMs) / 2);
    const ratio = windowMs === 0 ? 1 : Math.min(1, (audioMs - cue.startMs) / windowMs);
    const blend = ratio * ratio * (3 - 2 * ratio);
    for (const key of poseKeys) frame.mouth[key] = from[key] + (cue.pose[key] - from[key]) * blend;
    frame.phoneme = cue.phoneme;
    return frame;
  }
}

export function measureTiming(observations: readonly { expectedAudioMs: number; observedMotionMs: number }[]): {
  count: number; medianOffsetMs: number; maxAbsoluteOffsetMs: number;
} {
  if (!observations.length) throw new Error('Timing benchmark needs measured observations');
  const offsets = observations.map(item => {
    nonnegative(item.expectedAudioMs, 'expectedAudioMs');
    nonnegative(item.observedMotionMs, 'observedMotionMs');
    return item.observedMotionMs - item.expectedAudioMs;
  }).sort((a, b) => a - b);
  const middle = Math.floor(offsets.length / 2);
  return {
    count: offsets.length,
    medianOffsetMs: offsets.length % 2 ? offsets[middle] : (offsets[middle - 1] + offsets[middle]) / 2,
    maxAbsoluteOffsetMs: Math.max(...offsets.map(value => Math.abs(value))),
  };
}
