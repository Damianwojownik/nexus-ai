import { articulationAt } from './articulationEngine.ts';
import { hapticForCue } from './hapticsEngine.ts';
import { misMotionFrame, type MisMotionState } from './motionAdapter.ts';
import { phonemeAt } from './phonemeEngine.ts';
import type { MisLanguage, PhonemeCue } from './types.ts';

export type MisRuntimeFrame = {
  atMs:number;
  language:MisLanguage;
  phoneme:PhonemeCue;
  articulation:ReturnType<typeof articulationAt>;
  motion:ReturnType<typeof misMotionFrame>;
  haptic:ReturnType<typeof hapticForCue>;
};

/**
 * One-clock composition point for Miś Engine.
 * Mouth, body motion and haptics are sampled from the same timestamp.
 */
export function composeMisFrame(
  timeline:PhonemeCue[],
  language:MisLanguage,
  atMs:number,
  state:MisMotionState='SPEAKING',
):MisRuntimeFrame {
  const phoneme=phonemeAt(timeline,atMs);
  const articulation=articulationAt(timeline,atMs);
  return {
    atMs,
    language,
    phoneme,
    articulation,
    motion:misMotionFrame(state,atMs,articulation),
    haptic:hapticForCue(phoneme),
  };
}

export function sampleMisRuntime(
  timeline:PhonemeCue[],
  language:MisLanguage,
  fps=50,
  state:MisMotionState='SPEAKING',
):MisRuntimeFrame[]{
  const endMs=timeline[timeline.length-1]?.endMs ?? 0;
  const step=1000/Math.max(1,fps);
  const frames:MisRuntimeFrame[]=[];
  for(let atMs=0;atMs<=endMs;atMs+=step){
    frames.push(composeMisFrame(timeline,language,atMs,state));
  }
  return frames;
}
