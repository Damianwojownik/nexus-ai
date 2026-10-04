import { articulationAt } from './articulationEngine.ts';
import { hapticForCue } from './hapticsEngine.ts';
import {
  acceptAlignedPhonemes,
  buildEstimatedPhonemeTimeline,
  phonemeAt,
  type AlignedPhoneInput,
  type EstimateTimelineOptions,
} from './phonemeEngine.ts';
import type { MisEngineFrame, MisLanguage, PhonemeCue } from './types.ts';

export type MisSpeechInput =
  | {
      language: MisLanguage;
      mode: 'estimated';
      text: string;
      options?: EstimateTimelineOptions;
    }
  | {
      language: MisLanguage;
      mode: 'aligned';
      phones: AlignedPhoneInput[];
    };

export class MisEngine {
  readonly experimental = true;
  readonly label = 'Miś Engine v1 — TEST / EXPERIMENTAL';

  createTimeline(input: MisSpeechInput): PhonemeCue[] {
    if (input.mode === 'aligned') return acceptAlignedPhonemes(input.phones);
    return buildEstimatedPhonemeTimeline(input.text, input.language, input.options);
  }

  frameAt(input: MisSpeechInput, atMs: number): MisEngineFrame {
    const timeline = this.createTimeline(input);
    const phoneme = phonemeAt(timeline, atMs);
    return {
      atMs,
      language: input.language,
      phoneme,
      articulation: articulationAt(timeline, atMs),
      haptic: hapticForCue(phoneme),
    };
  }

  sample(input: MisSpeechInput, fps = 50): MisEngineFrame[] {
    const timeline = this.createTimeline(input);
    const endMs = timeline[timeline.length - 1]?.endMs ?? 0;
    const step = 1000 / Math.max(1, fps);
    const frames: MisEngineFrame[] = [];
    for (let atMs = 0; atMs <= endMs; atMs += step) {
      const phoneme = phonemeAt(timeline, atMs);
      frames.push({
        atMs,
        language: input.language,
        phoneme,
        articulation: articulationAt(timeline, atMs),
        haptic: hapticForCue(phoneme),
      });
    }
    return frames;
  }
}
