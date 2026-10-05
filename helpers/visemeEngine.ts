export type NexusViseme =
  | 'REST'
  | 'A'
  | 'E'
  | 'I'
  | 'O'
  | 'U'
  | 'MBP'
  | 'FV'
  | 'L'
  | 'SZ'
  | 'TD'
  | 'KG'
  | 'R';

export type VisemeCue = {
  viseme: NexusViseme;
  startMs: number;
  endMs: number;
  intensity: number;
};

const SAPI_VISEMES: readonly NexusViseme[] = [
  'REST', 'A', 'A', 'O', 'E', 'R', 'I', 'U', 'O', 'A', 'O',
  'A', 'A', 'R', 'L', 'SZ', 'SZ', 'TD', 'FV', 'TD', 'KG', 'MBP',
];

export function appendSapiVisemeCue(
  cues: VisemeCue[],
  visemeId: number,
  startMs: number,
  durationMs: number,
  emphasis = 0,
): void {
  if (!Number.isSafeInteger(visemeId) || visemeId < 0 || visemeId >= SAPI_VISEMES.length) {
    throw new Error('SAPI viseme ID must be an integer from 0 to 21');
  }
  if (!Number.isFinite(startMs) || startMs < 0) throw new Error('SAPI viseme start must be finite and nonnegative');
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error('SAPI viseme duration must be finite and nonnegative');
  if (emphasis !== 0 && emphasis !== 1 && emphasis !== 2) throw new Error('Unknown SAPI viseme emphasis');

  const previous = cues[cues.length - 1];
  if (previous && startMs < previous.startMs) throw new Error('SAPI viseme positions must be monotonic');
  const viseme = SAPI_VISEMES[visemeId];
  const cue: VisemeCue = {
    viseme,
    startMs,
    endMs: startMs + Math.max(1, durationMs),
    intensity: viseme === 'REST' ? 0 : emphasis === 2 ? 1 : emphasis === 1 ? 0.88 : 0.72,
  };
  if (previous && startMs === previous.startMs) {
    cues[cues.length - 1] = cue;
    return;
  }
  if (previous && previous.endMs > startMs) previous.endMs = startMs;
  cues.push(cue);
}

const LETTER_TO_VISEME: Record<string, NexusViseme> = {
  a: 'A', ą: 'O',
  e: 'E', ę: 'E',
  i: 'I', y: 'I',
  o: 'O', ó: 'U',
  u: 'U',
  m: 'MBP', b: 'MBP', p: 'MBP',
  f: 'FV', w: 'FV', v: 'FV',
  l: 'L', ł: 'L',
  s: 'SZ', z: 'SZ', c: 'SZ', ś: 'SZ', ź: 'SZ', ż: 'SZ', sz: 'SZ', cz: 'SZ',
  t: 'TD', d: 'TD', n: 'TD',
  k: 'KG', g: 'KG', h: 'KG', ch: 'KG',
  r: 'R',
};

const VOWELS = new Set(['a', 'ą', 'e', 'ę', 'i', 'o', 'ó', 'u', 'y']);

function normalizeToken(token: string) {
  return token.toLocaleLowerCase('pl-PL');
}

function tokenToVisemes(token: string): NexusViseme[] {
  const value = normalizeToken(token);
  const result: NexusViseme[] = [];

  for (let i = 0; i < value.length; i += 1) {
    const pair = value.slice(i, i + 2);
    const pairViseme = LETTER_TO_VISEME[pair];
    if (pairViseme) {
      result.push(pairViseme);
      i += 1;
      continue;
    }

    const char = value[i];
    if (/\s/.test(char)) {
      result.push('REST');
      continue;
    }

    const viseme = LETTER_TO_VISEME[char];
    if (viseme) result.push(viseme);
  }

  return result;
}

export type EstimateVisemeOptions = {
  charactersPerSecond?: number;
  minCueMs?: number;
  maxCueMs?: number;
  punctuationPauseMs?: number;
};

/**
 * Builds a deterministic estimated viseme timeline from text.
 *
 * This is a browser/offline fallback for TTS engines that do not expose
 * phoneme or viseme timing. It is intentionally NOT described as true
 * phoneme-aligned lip sync. A provider with real timing can replace this plan.
 */
export function estimateVisemePlan(
  text: string,
  options: EstimateVisemeOptions = {},
): VisemeCue[] {
  const cps = Math.max(4, options.charactersPerSecond ?? 14);
  const minCueMs = Math.max(28, options.minCueMs ?? 55);
  const maxCueMs = Math.max(minCueMs, options.maxCueMs ?? 150);
  const punctuationPauseMs = Math.max(0, options.punctuationPauseMs ?? 105);

  const cues: VisemeCue[] = [];
  let cursor = 0;

  const chunks = text.match(/[\p{L}]+|\s+|[^\p{L}\s]+/gu) ?? [];

  for (const chunk of chunks) {
    if (/^\s+$/.test(chunk)) {
      const duration = Math.min(95, 1000 * chunk.length / cps);
      cues.push({ viseme: 'REST', startMs: cursor, endMs: cursor + duration, intensity: 0.08 });
      cursor += duration;
      continue;
    }

    if (!/\p{L}/u.test(chunk)) {
      const duration = /[.!?]/.test(chunk) ? punctuationPauseMs * 1.45 : punctuationPauseMs;
      cues.push({ viseme: 'REST', startMs: cursor, endMs: cursor + duration, intensity: 0 });
      cursor += duration;
      continue;
    }

    const visemes = tokenToVisemes(chunk);
    if (!visemes.length) continue;

    const tokenDuration = Math.max(visemes.length * minCueMs, 1000 * chunk.length / cps);
    const cueDuration = Math.min(maxCueMs, Math.max(minCueMs, tokenDuration / visemes.length));

    visemes.forEach((viseme, index) => {
      const char = normalizeToken(chunk)[Math.min(index, chunk.length - 1)] ?? '';
      const vowelBoost = VOWELS.has(char) ? 0.18 : 0;
      const startMs = cursor;
      const endMs = cursor + cueDuration;
      cues.push({
        viseme,
        startMs,
        endMs,
        intensity: Math.min(1, 0.55 + vowelBoost),
      });
      cursor = endMs;
    });
  }

  if (!cues.length) {
    return [{ viseme: 'REST', startMs: 0, endMs: 1, intensity: 0 }];
  }

  return cues;
}

export function sampleVisemeAt(cues: VisemeCue[], elapsedMs: number): VisemeCue {
  if (!cues.length) return { viseme: 'REST', startMs: 0, endMs: 1, intensity: 0 };
  const t = Math.max(0, elapsedMs);
  const active = cues.find(cue => t >= cue.startMs && t < cue.endMs);
  return active ?? { viseme: 'REST', startMs: t, endMs: t + 1, intensity: 0 };
}

export type VisemeMouthShape = {
  open: number;
  wide: number;
  round: number;
  press: number;
};

const SHAPES: Record<NexusViseme, VisemeMouthShape> = {
  REST: { open: 0.04, wide: 0.15, round: 0.05, press: 0.1 },
  A:    { open: 0.95, wide: 0.38, round: 0.08, press: 0.0 },
  E:    { open: 0.48, wide: 0.92, round: 0.03, press: 0.0 },
  I:    { open: 0.28, wide: 1.0, round: 0.0, press: 0.0 },
  O:    { open: 0.72, wide: 0.25, round: 0.94, press: 0.0 },
  U:    { open: 0.34, wide: 0.12, round: 1.0, press: 0.0 },
  MBP:  { open: 0.02, wide: 0.3, round: 0.0, press: 1.0 },
  FV:   { open: 0.18, wide: 0.48, round: 0.0, press: 0.62 },
  L:    { open: 0.32, wide: 0.55, round: 0.0, press: 0.18 },
  SZ:   { open: 0.2, wide: 0.62, round: 0.12, press: 0.25 },
  TD:   { open: 0.22, wide: 0.42, round: 0.0, press: 0.22 },
  KG:   { open: 0.3, wide: 0.34, round: 0.0, press: 0.08 },
  R:    { open: 0.38, wide: 0.5, round: 0.0, press: 0.1 },
};

export function mouthShapeForViseme(viseme: NexusViseme): VisemeMouthShape {
  return SHAPES[viseme];
}
