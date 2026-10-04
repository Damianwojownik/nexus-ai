/**
 * Miś Engine v1 — TEST / EXPERIMENTAL.
 *
 * Technical prototype only. It is not a diagnostic or therapeutic device and
 * must not be presented as clinically validated without specialist validation.
 */

export type MisLanguage = 'pl' | 'en' | 'de';
export type TimelineSource = 'estimated-text' | 'aligned-audio';

export type PhonemeCue = {
  phoneme: string;
  startMs: number;
  endMs: number;
  confidence: number;
  source: TimelineSource;
};

export type ArticulationFrame = {
  jawOpen: number;
  lipRound: number;
  lipWide: number;
  lipProtrusion: number;
  lipPress: number;
  tongueX: number;
  tongueY: number;
  tongueTip: number;
  teethGap: number;
  voicing: number;
  airflow: number;
  nasal: number;
};

export type ArticulationControlPoint = Pick<
  ArticulationFrame,
  'jawOpen' | 'lipWide' | 'lipRound' | 'lipProtrusion' | 'lipPress'
> & {
  atMs: number;
};

export type HapticClass =
  | 'silence'
  | 'vowel'
  | 'voiced'
  | 'unvoiced'
  | 'plosive'
  | 'fricative'
  | 'nasal';

export type HapticCue = {
  startMs: number;
  endMs: number;
  kind: HapticClass;
  /** 0..1 target intensity for the physical teddy actuator. */
  intensity: number;
  /** Browser vibration fallback; timings only, no true amplitude control. */
  phonePattern: number[];
};

export type IdentityReference = {
  id: string;
  uri: string;
  view: 'front' | 'three-quarter-left' | 'three-quarter-right' | 'left' | 'right' | 'expression';
  weight?: number;
};

export type IdentityProfile = {
  id: string;
  label: string;
  subject: 'bear' | 'human' | 'other';
  references: IdentityReference[];
  version: number;
};

export type MisEngineFrame = {
  atMs: number;
  language: MisLanguage;
  phoneme: PhonemeCue;
  articulation: ArticulationFrame;
  haptic: HapticCue;
};
