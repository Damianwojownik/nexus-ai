import type { ArticulationFrame, PhonemeCue } from './types.ts';

export type MisBenchmarkSample = {
  atMs: number;
  audioEnergy?: number;
  mouthOpenObserved?: number;
  identityDistance?: number;
  articulationExpected?: Partial<ArticulationFrame>;
  articulationObserved?: Partial<ArticulationFrame>;
};

export type MisBenchmarkReport = {
  sampleCount: number;
  mouthAudioCorrelation?: number;
  estimatedLagMs?: number;
  identityDriftMean?: number;
  identityDriftMax?: number;
  articulationMae?: number;
};

function pearson(a:number[], b:number[]):number|undefined {
  if (a.length !== b.length || a.length < 3) return undefined;
  const ma=a.reduce((s,x)=>s+x,0)/a.length;
  const mb=b.reduce((s,x)=>s+x,0)/b.length;
  let num=0,da=0,db=0;
  for(let i=0;i<a.length;i++){
    const xa=a[i]-ma, xb=b[i]-mb;
    num+=xa*xb; da+=xa*xa; db+=xb*xb;
  }
  const den=Math.sqrt(da*db);
  return den > 0 ? num/den : undefined;
}

export function estimateLagMs(samples:MisBenchmarkSample[], maxLagMs=700):number|undefined {
  const usable=samples.filter(s=>Number.isFinite(s.audioEnergy) && Number.isFinite(s.mouthOpenObserved));
  if(usable.length<8) return undefined;
  const step=Math.max(1, Math.round((usable[usable.length-1].atMs-usable[0].atMs)/(usable.length-1)));
  const maxShift=Math.max(1,Math.floor(maxLagMs/step));
  let best:{lag:number;score:number}|undefined;
  for(let shift=-maxShift;shift<=maxShift;shift++){
    const a:number[]=[],m:number[]=[];
    for(let i=0;i<usable.length;i++){
      const j=i+shift;
      if(j<0||j>=usable.length) continue;
      a.push(usable[i].audioEnergy!);
      m.push(usable[j].mouthOpenObserved!);
    }
    const score=pearson(a,m);
    if(score!==undefined && (!best || score>best.score)) best={lag:shift*step,score};
  }
  return best?.lag;
}

export function benchmark(samples:MisBenchmarkSample[]):MisBenchmarkReport {
  const audio=samples.filter(s=>Number.isFinite(s.audioEnergy)&&Number.isFinite(s.mouthOpenObserved));
  const drift=samples.map(s=>s.identityDistance).filter((x):x is number=>Number.isFinite(x));
  const articulationErrors:number[]=[];

  for(const s of samples){
    if(!s.articulationExpected || !s.articulationObserved) continue;
    for(const key of Object.keys(s.articulationExpected) as (keyof ArticulationFrame)[]){
      const a=s.articulationExpected[key], b=s.articulationObserved[key];
      if(Number.isFinite(a) && Number.isFinite(b)) articulationErrors.push(Math.abs(a!-b!));
    }
  }

  return {
    sampleCount:samples.length,
    mouthAudioCorrelation:audio.length>=3
      ? pearson(audio.map(s=>s.audioEnergy!),audio.map(s=>s.mouthOpenObserved!))
      : undefined,
    estimatedLagMs:estimateLagMs(samples),
    identityDriftMean:drift.length ? drift.reduce((s,x)=>s+x,0)/drift.length : undefined,
    identityDriftMax:drift.length ? Math.max(...drift) : undefined,
    articulationMae:articulationErrors.length
      ? articulationErrors.reduce((s,x)=>s+x,0)/articulationErrors.length
      : undefined,
  };
}

export function validateTimeline(timeline:PhonemeCue[]):string[] {
  const errors:string[]=[];
  for(let i=0;i<timeline.length;i++){
    const cue=timeline[i];
    if(cue.endMs<=cue.startMs) errors.push(`cue ${i}: non-positive duration`);
    if(i>0 && cue.startMs<timeline[i-1].startMs) errors.push(`cue ${i}: non-monotonic start`);
    if(cue.confidence<0||cue.confidence>1) errors.push(`cue ${i}: confidence out of range`);
  }
  return errors;
}
