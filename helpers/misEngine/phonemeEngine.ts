import type { MisLanguage, PhonemeCue, TimelineSource } from './types.ts';

type Rule = { text: string; phonemes: string[] };

const RULES: Record<MisLanguage, Rule[]> = {
  pl: [
    { text: 'dź', phonemes: ['dʑ'] }, { text: 'dzi', phonemes: ['dʑ'] },
    { text: 'dż', phonemes: ['dʐ'] }, { text: 'cz', phonemes: ['tʂ'] },
    { text: 'sz', phonemes: ['ʂ'] }, { text: 'rz', phonemes: ['ʐ'] },
    { text: 'ch', phonemes: ['x'] }, { text: 'ci', phonemes: ['tɕ'] },
    { text: 'si', phonemes: ['ɕ'] }, { text: 'zi', phonemes: ['ʑ'] },
    { text: 'ni', phonemes: ['ɲ'] },
  ],
  en: [
    { text: 'th', phonemes: ['θ'] },
    { text: 'sh', phonemes: ['ʃ'] },
    { text: 'ch', phonemes: ['tʃ'] },
    { text: 'ng', phonemes: ['ŋ'] },
    { text: 'oo', phonemes: ['u'] },
    { text: 'ee', phonemes: ['i'] },
  ],
  de: [
    { text: 'sch', phonemes: ['ʃ'] },
    { text: 'ch', phonemes: ['ç'] },
    { text: 'ei', phonemes: ['aɪ'] },
    { text: 'ie', phonemes: ['i'] },
    { text: 'eu', phonemes: ['ɔʏ'] },
    { text: 'äu', phonemes: ['ɔʏ'] },
  ],
};

const CHARS: Record<MisLanguage, Record<string, string[]>> = {
  pl: {
    a:['a'], ą:['ɔ̃'], b:['b'], c:['t','s'], ć:['tɕ'], d:['d'], e:['ɛ'], ę:['ɛ̃'], f:['f'], g:['g'],
    h:['x'], i:['i'], j:['j'], k:['k'], l:['l'], ł:['w'], m:['m'], n:['n'], ń:['ɲ'], o:['ɔ'], ó:['u'],
    p:['p'], r:['r'], s:['s'], ś:['ɕ'], t:['t'], u:['u'], w:['v'], y:['ɨ'], z:['z'], ź:['ʑ'], ż:['ʐ']
  },
  en: {
    a:['æ'], b:['b'], c:['k'], d:['d'], e:['ɛ'], f:['f'], g:['g'], h:['h'], i:['ɪ'], j:['dʒ'],
    k:['k'], l:['l'], m:['m'], n:['n'], o:['ɒ'], p:['p'], q:['k'], r:['ɹ'], s:['s'], t:['t'],
    u:['ʌ'], v:['v'], w:['w'], x:['k','s'], y:['j'], z:['z']
  },
  de: {
    a:['a'], ä:['ɛ'], b:['b'], c:['k'], d:['d'], e:['e'], f:['f'], g:['g'], h:['h'], i:['ɪ'],
    j:['j'], k:['k'], l:['l'], m:['m'], n:['n'], o:['o'], ö:['ø'], p:['p'], q:['k'], r:['ʁ'],
    s:['z'], ß:['s'], t:['t'], u:['u'], ü:['y'], v:['f'], w:['v'], x:['k','s'], y:['y'], z:['t','s']
  },
};

function normalize(text: string, language: MisLanguage): string {
  const locale = language === 'pl' ? 'pl-PL' : language === 'de' ? 'de-DE' : 'en-US';
  return text.toLocaleLowerCase(locale).normalize('NFC');
}

export function estimatePhonemes(text: string, language: MisLanguage): string[] {
  const input = normalize(text, language);
  const out: string[] = [];
  const rules = [...RULES[language]].sort((a,b) => b.text.length - a.text.length);

  for (let i = 0; i < input.length;) {
    const ch = input[i];
    if (/\s/u.test(ch)) { out.push('sil'); i += 1; continue; }
    if (!/\p{L}/u.test(ch)) { out.push('sil'); i += 1; continue; }

    const rule = rules.find(r => input.startsWith(r.text, i));
    if (rule) {
      out.push(...rule.phonemes);
      i += rule.text.length;
      continue;
    }

    const mapped = CHARS[language][ch];
    if (mapped) out.push(...mapped);
    i += 1;
  }

  return out.length ? out : ['sil'];
}

export type EstimateTimelineOptions = {
  charactersPerSecond?: number;
  minCueMs?: number;
  maxCueMs?: number;
};

/**
 * Deterministic fallback only. English and German spelling are especially
 * non-phonemic, so this must never be described as audio-aligned lip sync.
 */
export function buildEstimatedPhonemeTimeline(
  text: string,
  language: MisLanguage,
  options: EstimateTimelineOptions = {},
): PhonemeCue[] {
  const cps = Math.max(4, options.charactersPerSecond ?? 13);
  const minCueMs = Math.max(35, options.minCueMs ?? 65);
  const maxCueMs = Math.max(minCueMs, options.maxCueMs ?? 180);
  const phonemes = estimatePhonemes(text, language);
  const voicedCount = Math.max(1, phonemes.filter(p => p !== 'sil').length);
  const duration = Math.max(voicedCount * minCueMs, (text.length / cps) * 1000);
  const cueMs = Math.min(maxCueMs, Math.max(minCueMs, duration / voicedCount));

  let cursor = 0;
  return phonemes.map(phoneme => {
    const silence = phoneme === 'sil';
    const d = silence ? Math.min(110, cueMs * 0.7) : cueMs;
    const cue: PhonemeCue = {
      phoneme,
      startMs: cursor,
      endMs: cursor + d,
      confidence: silence ? 1 : 0.25,
      source: 'estimated-text',
    };
    cursor += d;
    return cue;
  });
}

export type AlignedPhoneInput = {
  phoneme: string;
  startMs: number;
  endMs: number;
  confidence?: number;
};

/**
 * Adapter boundary for a future forced-aligner/ASR. The actual alignment model
 * can be replaced without changing the rest of Miś Engine.
 */
export function acceptAlignedPhonemes(items: AlignedPhoneInput[]): PhonemeCue[] {
  return items
    .filter(x => Number.isFinite(x.startMs) && Number.isFinite(x.endMs) && x.endMs > x.startMs)
    .sort((a,b) => a.startMs - b.startMs)
    .map(x => ({
      phoneme: x.phoneme.trim() || 'sil',
      startMs: Math.max(0, x.startMs),
      endMs: Math.max(0, x.endMs),
      confidence: Math.max(0, Math.min(1, x.confidence ?? 1)),
      source: 'aligned-audio' as TimelineSource,
    }));
}

export function phonemeAt(timeline: PhonemeCue[], atMs: number): PhonemeCue {
  if (!timeline.length) {
    return { phoneme:'sil', startMs:0, endMs:1, confidence:1, source:'estimated-text' };
  }
  const t = Math.max(0, atMs);
  return timeline.find(c => t >= c.startMs && t < c.endMs) ?? timeline[timeline.length - 1];
}
