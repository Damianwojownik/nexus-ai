import type { VoiceEventType } from './agentProtocol.ts';

export type AvatarMotionFrame = {
  state: VoiceEventType;
  breath: number;
  headX: number;
  headY: number;
  gazeX: number;
  gazeY: number;
  blink: number;
  mouthOpen: number;
  speechEnergy: number;
  shoulderSway: number;
  nod: number;
  expression: 'neutral' | 'attentive' | 'thinking' | 'speaking' | 'focused' | 'error';
};

export type AvatarMotionInput = {
  state: VoiceEventType;
  nowMs: number;
  speechEnergy?: number;
  visemeOpen?: number;
};

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

export function createAvatarMotionFrame(input: AvatarMotionInput): AvatarMotionFrame {
  const t = input.nowMs / 1000;
  const energy = clamp(input.speechEnergy ?? 0);
  const speaking = input.state === 'SPEAKING';
  const listening = input.state === 'LISTENING';
  const thinking = input.state === 'THINKING';
  const executing = input.state === 'EXECUTING';

  const breath = Math.sin(t * Math.PI * 0.45);
  const headAmplitude = listening ? 1.4 : speaking ? 1.1 : thinking ? 0.7 : 0.45;
  const gazeAmplitude = listening ? 1.8 : thinking ? 1.2 : 0.6;
  // Two incommensurate cycles avoid a robotic fixed blink cadence; an occasional
  // second blink creates a more human double-blink without randomness in tests.
  const blinkPhase = (input.nowMs % 4870) / 4870;
  const microPhase = (input.nowMs % 11270) / 11270;
  const primaryBlink = blinkPhase > 0.958 ? Math.sin(((blinkPhase - 0.958) / 0.042) * Math.PI) : 0;
  const doubleBlink = microPhase > 0.973 && microPhase < 0.986
    ? Math.sin(((microPhase - 0.973) / 0.013) * Math.PI)
    : 0;
  const blink = clamp(Math.max(primaryBlink, doubleBlink));
  const mouthOpen = speaking ? clamp(input.visemeOpen ?? (0.18 + energy * 0.82)) : 0;

  return {
    state: input.state,
    breath,
    headX: (Math.sin(t * 0.73) + 0.22 * Math.sin(t * 0.19 + 1.7)) * headAmplitude,
    headY: (Math.sin(t * 0.51 + 0.8) + 0.18 * Math.sin(t * 0.23)) * headAmplitude * 0.55,
    gazeX: Math.sin(t * 0.39 + 1.4) * gazeAmplitude,
    gazeY: Math.sin(t * 0.31) * gazeAmplitude * 0.55,
    blink,
    mouthOpen,
    speechEnergy: energy,
    shoulderSway: Math.sin(t * (speaking ? 1.35 : 0.42) + 0.4) * (speaking ? 0.85 : listening ? 0.38 : 0.22),
    nod: (listening ? Math.max(0, Math.sin(t * 0.72 - 1.1)) ** 8 * 1.15 : speaking ? Math.sin(t * 1.18) * 0.16 : 0),
    expression:
      input.state === 'ERROR' ? 'error'
      : speaking ? 'speaking'
      : listening ? 'attentive'
      : thinking ? 'thinking'
      : executing ? 'focused'
      : 'neutral',
  };
}

export function avatarMotionCssVars(frame: AvatarMotionFrame): Record<string, string> {
  return {
    '--nexus-breath': frame.breath.toFixed(3),
    '--nexus-head-x': `${frame.headX.toFixed(2)}deg`,
    '--nexus-head-y': `${frame.headY.toFixed(2)}deg`,
    '--nexus-gaze-x': `${frame.gazeX.toFixed(2)}px`,
    '--nexus-gaze-y': `${frame.gazeY.toFixed(2)}px`,
    '--nexus-blink': frame.blink.toFixed(3),
    '--nexus-mouth': frame.mouthOpen.toFixed(3),
    '--nexus-speech-energy': frame.speechEnergy.toFixed(3),
    '--nexus-shoulder-sway': `${frame.shoulderSway.toFixed(2)}deg`,
    '--nexus-nod': `${frame.nod.toFixed(2)}deg`,
  };
}
