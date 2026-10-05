import type { HapticClass, HapticCue, PhonemeCue } from './types.ts';

const VOWELS = new Set(['a','æ','ɑ','ɛ','e','i','ɪ','ɨ','ɔ','o','u','y','ø','ʌ','ɒ','ɔ̃','ɛ̃','aɪ','aʊ','ɔʏ']);
const NASALS = new Set(['m','n','ɲ','ŋ']);
const PLOSIVES = new Set(['p','b','t','d','k','g','c','ɟ','ts','dz','tɕ','dʑ','tʂ','dʐ','tʃ','dʒ']);
const FRICATIVES = new Set(['f','v','s','z','ɕ','ʑ','ʂ','ʐ','ʃ','θ','ð','x','ç','h']);
const VOICED = new Set(['b','d','g','v','z','ʑ','ʐ','ð','m','n','ɲ','ŋ','l','r','ɹ','ʁ','j','w']);

export function classifyHaptic(phoneme:string):HapticClass {
  if (phoneme === 'sil') return 'silence';
  if (VOWELS.has(phoneme)) return 'vowel';
  if (NASALS.has(phoneme)) return 'nasal';
  if (PLOSIVES.has(phoneme)) return 'plosive';
  if (FRICATIVES.has(phoneme)) return 'fricative';
  if (VOICED.has(phoneme)) return 'voiced';
  return 'unvoiced';
}

export function hapticForCue(cue:PhonemeCue):HapticCue {
  const kind=classifyHaptic(cue.phoneme);
  const duration=Math.max(1,Math.round(cue.endMs-cue.startMs));

  switch(kind){
    case 'silence':
      return {startMs:cue.startMs,endMs:cue.endMs,kind,intensity:0,phonePattern:[]};
    case 'vowel':
      return {startMs:cue.startMs,endMs:cue.endMs,kind,intensity:.68,phonePattern:[Math.min(duration,180)]};
    case 'nasal':
      return {startMs:cue.startMs,endMs:cue.endMs,kind,intensity:.58,phonePattern:[Math.min(duration,160)]};
    case 'plosive':
      return {startMs:cue.startMs,endMs:cue.endMs,kind,intensity:.82,phonePattern:[38]};
    case 'fricative':
      return {startMs:cue.startMs,endMs:cue.endMs,kind,intensity:.44,phonePattern:[24,22,24,22,24]};
    case 'voiced':
      return {startMs:cue.startMs,endMs:cue.endMs,kind,intensity:.54,phonePattern:[Math.min(duration,120)]};
    default:
      return {startMs:cue.startMs,endMs:cue.endMs,kind,intensity:.34,phonePattern:[30]};
  }
}

export function buildHapticTimeline(timeline:PhonemeCue[]):HapticCue[] {
  return timeline.map(hapticForCue);
}
