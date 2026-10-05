/**
 * Miś Engine renderer registry — TEST / EXPERIMENTAL.
 * Keeps rendering backends replaceable and separates therapeutic control data
 * from any single video vendor/model.
 */

export type MisRenderMode = 'live' | 'quality' | 'benchmark';
export type MisRendererId =
  | 'faster-liveportrait'
  | 'nexus-media-flp-ltx'
  | 'vidu-s2'
  | 'echomimic'
  | 'musetalk';

export type MisRendererSpec = {
  id: MisRendererId;
  role: 'portrait-motion' | 'full-body' | 'realtime-avatar' | 'lip-sync';
  mode: MisRenderMode[];
  selfHosted: boolean;
  supportsAnimal: boolean;
  supportsAudio: boolean;
  supportsReferenceImage: boolean;
  enabled: boolean;
  notes: string;
};

function envEnabled(name:string, fallback:boolean):boolean {
  const value=typeof process !== 'undefined' ? process.env?.[name] : undefined;
  if(value == null) return fallback;
  return !['0','false','off','no'].includes(value.toLowerCase());
}

export function misRendererRegistry():MisRendererSpec[] {
  return [
    {
      id:'faster-liveportrait',
      role:'portrait-motion',
      mode:['live','benchmark'],
      selfHosted:true,
      supportsAnimal:true,
      supportsAudio:true,
      supportsReferenceImage:true,
      enabled:envEnabled('MIS_ENGINE_FLP',true),
      notes:'Fast local bear/animal portrait motion. Primary Miś Engine v1 realtime renderer.',
    },
    {
      id:'nexus-media-flp-ltx',
      role:'full-body',
      mode:['quality','benchmark'],
      selfHosted:true,
      supportsAnimal:true,
      supportsAudio:true,
      supportsReferenceImage:true,
      enabled:envEnabled('MIS_ENGINE_MEDIA',true),
      notes:'Codex media engine: FasterLivePortrait face + LTX-Video body + compositor.',
    },
    {
      id:'vidu-s2',
      role:'realtime-avatar',
      mode:['live','benchmark'],
      selfHosted:false,
      supportsAnimal:true,
      supportsAudio:true,
      supportsReferenceImage:true,
      enabled:envEnabled('MIS_ENGINE_VIDU',false),
      notes:'External benchmark/fallback only; Miś phoneme/articulation logic remains vendor-independent.',
    },
    {
      id:'echomimic',
      role:'full-body',
      mode:['quality','benchmark'],
      selfHosted:true,
      supportsAnimal:false,
      supportsAudio:true,
      supportsReferenceImage:true,
      enabled:envEnabled('MIS_ENGINE_ECHOMIMIC',false),
      notes:'Optional quality renderer; requires explicit validation for non-human bear character.',
    },
    {
      id:'musetalk',
      role:'lip-sync',
      mode:['quality','benchmark'],
      selfHosted:true,
      supportsAnimal:false,
      supportsAudio:true,
      supportsReferenceImage:false,
      enabled:envEnabled('MIS_ENGINE_MUSETALK',false),
      notes:'Optional lip-sync post-process; not trusted for articulatory correctness by itself.',
    },
  ];
}

export function selectMisRenderer(mode:MisRenderMode):MisRendererSpec {
  const preferred:MisRendererId[] = mode === 'live'
    ? ['faster-liveportrait','vidu-s2']
    : mode === 'quality'
      ? ['nexus-media-flp-ltx','echomimic','faster-liveportrait']
      : ['faster-liveportrait','nexus-media-flp-ltx','vidu-s2'];

  const registry=misRendererRegistry();
  for(const id of preferred){
    const found=registry.find(x=>x.id===id && x.enabled && x.mode.includes(mode));
    if(found) return found;
  }
  throw new Error(`No enabled Miś renderer for mode ${mode}`);
}
