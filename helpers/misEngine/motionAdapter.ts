import { createAvatarMotionFrame, type AvatarMotionFrame } from '../avatarMotion.ts';
import type { ArticulationFrame } from './types.ts';

export type MisMotionState = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING' | 'EXECUTING' | 'INTERRUPTED' | 'ERROR';

const ENERGY_BY_ARTICULATION = (a:ArticulationFrame) =>
  Math.max(0, Math.min(1, a.voicing * .52 + a.airflow * .28 + a.jawOpen * .20));

/**
 * Reuses the existing Nexus avatar motion engine instead of duplicating it.
 * Miś Engine owns articulation; Nexus motion owns blink/gaze/head/breath/body.
 */
export function misMotionFrame(
  state:MisMotionState,
  nowMs:number,
  articulation:ArticulationFrame,
):AvatarMotionFrame {
  return createAvatarMotionFrame({
    state,
    nowMs,
    speechEnergy: state === 'SPEAKING' ? ENERGY_BY_ARTICULATION(articulation) : 0,
    visemeOpen: articulation.jawOpen,
  });
}
