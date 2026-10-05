import type { ArticulationFrame, PhonemeCue } from './types.ts';

const clamp = (v:number) => Math.max(0, Math.min(1, v));
const mix = (a:number,b:number,t:number) => a + (b-a)*t;
const ease = (t:number) => {
  const x=clamp(t);
  return x*x*(3-2*x);
};

const REST: ArticulationFrame = {
  jawOpen:0.04, lipRound:0.06, lipWide:0.18, lipProtrusion:0.04, lipPress:0.08,
  tongueX:0.5, tongueY:0.42, tongueTip:0.18, teethGap:0.08, voicing:0, airflow:0.05, nasal:0,
};

function frame(partial: Partial<ArticulationFrame>): ArticulationFrame {
  return { ...REST, ...partial };
}

const VOWELS: Record<string, ArticulationFrame> = {
  a: frame({jawOpen:.92,lipWide:.40,tongueY:.18,teethGap:.86,voicing:1,airflow:.50}),
  æ: frame({jawOpen:.76,lipWide:.72,tongueX:.35,tongueY:.36,teethGap:.70,voicing:1,airflow:.48}),
  ɑ: frame({jawOpen:.90,lipWide:.35,tongueX:.68,tongueY:.18,teethGap:.84,voicing:1,airflow:.50}),
  ɛ: frame({jawOpen:.52,lipWide:.78,tongueX:.36,tongueY:.56,teethGap:.48,voicing:1,airflow:.46}),
  e: frame({jawOpen:.38,lipWide:.80,tongueX:.32,tongueY:.68,teethGap:.35,voicing:1,airflow:.42}),
  i: frame({jawOpen:.22,lipWide:.96,tongueX:.25,tongueY:.88,teethGap:.20,voicing:1,airflow:.38}),
  ɪ: frame({jawOpen:.30,lipWide:.82,tongueX:.30,tongueY:.74,teethGap:.28,voicing:1,airflow:.40}),
  ɨ: frame({jawOpen:.30,lipWide:.60,tongueX:.50,tongueY:.76,teethGap:.27,voicing:1,airflow:.40}),
  ɔ: frame({jawOpen:.62,lipRound:.82,lipWide:.20,lipProtrusion:.54,tongueX:.68,tongueY:.42,teethGap:.54,voicing:1,airflow:.48}),
  o: frame({jawOpen:.45,lipRound:.88,lipWide:.14,lipProtrusion:.64,tongueX:.70,tongueY:.58,teethGap:.39,voicing:1,airflow:.44}),
  u: frame({jawOpen:.28,lipRound:.98,lipWide:.08,lipProtrusion:.86,tongueX:.74,tongueY:.78,teethGap:.23,voicing:1,airflow:.38}),
  y: frame({jawOpen:.25,lipRound:.94,lipWide:.10,lipProtrusion:.78,tongueX:.28,tongueY:.86,teethGap:.20,voicing:1,airflow:.38}),
  ø: frame({jawOpen:.34,lipRound:.88,lipWide:.14,lipProtrusion:.72,tongueX:.32,tongueY:.70,teethGap:.30,voicing:1,airflow:.41}),
  ʌ: frame({jawOpen:.54,lipWide:.38,tongueX:.52,tongueY:.42,teethGap:.48,voicing:1,airflow:.45}),
  ɒ: frame({jawOpen:.66,lipRound:.76,lipWide:.22,lipProtrusion:.48,tongueX:.70,tongueY:.33,teethGap:.58,voicing:1,airflow:.48}),
};

const CONSONANTS: Record<string, ArticulationFrame> = {
  m: frame({jawOpen:.02,lipPress:1,voicing:1,airflow:.18,nasal:1}),
  b: frame({jawOpen:.01,lipPress:1,voicing:1,airflow:.14}),
  p: frame({jawOpen:.01,lipPress:1,voicing:0,airflow:.72}),
  f: frame({jawOpen:.13,lipWide:.46,lipPress:.35,teethGap:.06,voicing:0,airflow:.72}),
  v: frame({jawOpen:.13,lipWide:.46,lipPress:.35,teethGap:.06,voicing:1,airflow:.58}),
  s: frame({jawOpen:.16,lipWide:.72,tongueX:.46,tongueY:.72,tongueTip:.78,teethGap:.12,voicing:0,airflow:.88}),
  z: frame({jawOpen:.16,lipWide:.72,tongueX:.46,tongueY:.72,tongueTip:.78,teethGap:.12,voicing:1,airflow:.72}),
  ɕ: frame({jawOpen:.18,lipWide:.58,tongueX:.34,tongueY:.82,tongueTip:.68,teethGap:.14,voicing:0,airflow:.86}),
  ʑ: frame({jawOpen:.18,lipWide:.58,tongueX:.34,tongueY:.82,tongueTip:.68,teethGap:.14,voicing:1,airflow:.70}),
  ʂ: frame({jawOpen:.20,lipRound:.22,lipProtrusion:.18,tongueX:.58,tongueY:.78,tongueTip:.82,teethGap:.16,voicing:0,airflow:.88}),
  ʐ: frame({jawOpen:.20,lipRound:.22,lipProtrusion:.18,tongueX:.58,tongueY:.78,tongueTip:.82,teethGap:.16,voicing:1,airflow:.72}),
  ʃ: frame({jawOpen:.20,lipRound:.20,lipProtrusion:.20,tongueX:.52,tongueY:.79,tongueTip:.76,teethGap:.16,voicing:0,airflow:.86}),
  θ: frame({jawOpen:.20,lipWide:.46,tongueX:.50,tongueY:.60,tongueTip:1,teethGap:.22,voicing:0,airflow:.82}),
  ð: frame({jawOpen:.20,lipWide:.46,tongueX:.50,tongueY:.60,tongueTip:1,teethGap:.22,voicing:1,airflow:.68}),
  t: frame({jawOpen:.14,lipWide:.40,tongueX:.45,tongueY:.78,tongueTip:.92,teethGap:.10,voicing:0,airflow:.58}),
  d: frame({jawOpen:.14,lipWide:.40,tongueX:.45,tongueY:.78,tongueTip:.92,teethGap:.10,voicing:1,airflow:.46}),
  n: frame({jawOpen:.14,lipWide:.40,tongueX:.45,tongueY:.78,tongueTip:.92,teethGap:.10,voicing:1,airflow:.24,nasal:1}),
  l: frame({jawOpen:.28,lipWide:.50,tongueX:.42,tongueY:.72,tongueTip:.98,teethGap:.24,voicing:1,airflow:.35}),
  r: frame({jawOpen:.30,lipWide:.48,tongueX:.50,tongueY:.74,tongueTip:.92,teethGap:.25,voicing:1,airflow:.48}),
  'ɹ': frame({jawOpen:.28,lipRound:.18,tongueX:.62,tongueY:.72,tongueTip:.55,teethGap:.24,voicing:1,airflow:.40}),
  'ʁ': frame({jawOpen:.28,lipRound:.14,tongueX:.80,tongueY:.62,tongueTip:.20,teethGap:.24,voicing:1,airflow:.48}),
  k: frame({jawOpen:.24,tongueX:.78,tongueY:.76,tongueTip:.18,teethGap:.20,voicing:0,airflow:.62}),
  g: frame({jawOpen:.24,tongueX:.78,tongueY:.76,tongueTip:.18,teethGap:.20,voicing:1,airflow:.50}),
  x: frame({jawOpen:.28,tongueX:.78,tongueY:.67,tongueTip:.18,teethGap:.25,voicing:0,airflow:.84}),
  ç: frame({jawOpen:.22,lipWide:.52,tongueX:.38,tongueY:.86,tongueTip:.26,teethGap:.18,voicing:0,airflow:.84}),
  h: frame({jawOpen:.34,tongueY:.38,teethGap:.30,voicing:0,airflow:.90}),
  j: frame({jawOpen:.22,lipWide:.68,tongueX:.28,tongueY:.88,teethGap:.18,voicing:1,airflow:.36}),
  w: frame({jawOpen:.18,lipRound:.90,lipProtrusion:.72,tongueX:.72,tongueY:.72,teethGap:.14,voicing:1,airflow:.34}),
  'ŋ': frame({jawOpen:.20,tongueX:.80,tongueY:.76,tongueTip:.15,teethGap:.17,voicing:1,airflow:.22,nasal:1}),
  'ɲ': frame({jawOpen:.18,tongueX:.33,tongueY:.84,tongueTip:.45,teethGap:.15,voicing:1,airflow:.22,nasal:1}),
  'tɕ': frame({jawOpen:.18,lipWide:.56,tongueX:.34,tongueY:.84,tongueTip:.72,teethGap:.14,voicing:0,airflow:.78}),
  'dʑ': frame({jawOpen:.18,lipWide:.56,tongueX:.34,tongueY:.84,tongueTip:.72,teethGap:.14,voicing:1,airflow:.64}),
  'tʂ': frame({jawOpen:.20,lipRound:.18,tongueX:.58,tongueY:.80,tongueTip:.84,teethGap:.16,voicing:0,airflow:.80}),
  'dʐ': frame({jawOpen:.20,lipRound:.18,tongueX:.58,tongueY:.80,tongueTip:.84,teethGap:.16,voicing:1,airflow:.66}),
  'tʃ': frame({jawOpen:.20,lipRound:.18,lipProtrusion:.16,tongueX:.50,tongueY:.80,tongueTip:.78,teethGap:.16,voicing:0,airflow:.80}),
  'dʒ': frame({jawOpen:.20,lipRound:.18,lipProtrusion:.16,tongueX:.50,tongueY:.80,tongueTip:.78,teethGap:.16,voicing:1,airflow:.66}),
  'ts': frame({jawOpen:.17,lipWide:.68,tongueX:.46,tongueY:.76,tongueTip:.88,teethGap:.13,voicing:0,airflow:.82}),
  'dz': frame({jawOpen:.17,lipWide:.68,tongueX:.46,tongueY:.76,tongueTip:.88,teethGap:.13,voicing:1,airflow:.68}),
  'c': frame({jawOpen:.17,lipWide:.54,tongueX:.34,tongueY:.86,tongueTip:.48,teethGap:.13,voicing:0,airflow:.58}),
  'ɟ': frame({jawOpen:.17,lipWide:.54,tongueX:.34,tongueY:.86,tongueTip:.48,teethGap:.13,voicing:1,airflow:.46}),
  'ʔ': frame({jawOpen:.18,lipWide:.30,tongueX:.50,tongueY:.44,tongueTip:.18,teethGap:.14,voicing:0,airflow:.08}),
};

const NASAL_VOWELS: Record<string, ArticulationFrame> = {
  'ɔ̃': frame({...VOWELS['ɔ'], nasal:.72}),
  'ɛ̃': frame({...VOWELS['ɛ'], nasal:.72}),
};

export function articulationTarget(phoneme:string): ArticulationFrame {
  if (phoneme === 'sil') return REST;
  if (NASAL_VOWELS[phoneme]) return NASAL_VOWELS[phoneme];
  if (VOWELS[phoneme]) return VOWELS[phoneme];
  if (CONSONANTS[phoneme]) return CONSONANTS[phoneme];

  if (phoneme === 'aɪ') return frame({...VOWELS.a, lipWide:.54, tongueY:.42});
  if (phoneme === 'aʊ') return frame({...VOWELS.a, lipRound:.44, lipProtrusion:.38, tongueX:.62, tongueY:.48});
  if (phoneme === 'ɔʏ') return frame({...VOWELS['ɔ'], lipRound:.72, tongueX:.45, tongueY:.56});
  return REST;
}

function blendFrame(a:ArticulationFrame,b:ArticulationFrame,t:number):ArticulationFrame {
  const out={} as ArticulationFrame;
  (Object.keys(a) as (keyof ArticulationFrame)[]).forEach(k => { out[k]=clamp(mix(a[k],b[k],t)); });
  return out;
}

/**
 * Samples a phoneme timeline with anticipatory and carry-over coarticulation.
 * The result is deterministic and can drive CSS/2D/3D or a neural renderer.
 */
export function articulationAt(timeline:PhonemeCue[], atMs:number):ArticulationFrame {
  if (!timeline.length) return REST;
  const found=timeline.findIndex(c => atMs>=c.startMs && atMs<c.endMs);
  const i=found >= 0 ? found : atMs < timeline[0].startMs ? 0 : timeline.length-1;
  const cue=timeline[i];
  const current=articulationTarget(cue.phoneme);
  const prev=articulationTarget(timeline[Math.max(0,i-1)]?.phoneme ?? 'sil');
  const next=articulationTarget(timeline[Math.min(timeline.length-1,i+1)]?.phoneme ?? 'sil');
  const duration=Math.max(1,cue.endMs-cue.startMs);
  const phase=clamp((atMs-cue.startMs)/duration);

  // First 18% carries the previous phone; final 28% anticipates the next.
  if (phase < .18) return blendFrame(prev,current,ease(phase/.18));
  if (phase > .72) return blendFrame(current,next,ease((phase-.72)/.28));
  return current;
}
