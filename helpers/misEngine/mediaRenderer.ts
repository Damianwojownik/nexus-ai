export type MisMediaRenderInput = {
  sourceImageBase64:string;
  sourceImageMime?:string;
  audioBase64:string;
  audioMime?:string;
  bodyPrompt?:string;
  negativePrompt?:string;
  width?:number;
  height?:number;
  fps?:number;
  numFrames?:number;
  seed?:number;
  faceProtect?:number;
  feather?:number;
};

export type MisMediaHealth = {
  configured:boolean;
  ok:boolean;
  provider?:string;
  version?:string;
  message?:string;
  gpu?:unknown;
};

function cleanBase64(value:string):string {
  const comma=value.indexOf(',');
  return comma>=0 && value.slice(0,comma).includes('base64') ? value.slice(comma+1) : value;
}

function decodeBase64(value:string):Uint8Array {
  return Uint8Array.from(Buffer.from(cleanBase64(value),'base64'));
}

/**
 * Miś-specific adapter for the Codex Nexus Media Engine (FLP + LTX + compositor).
 * No renderer logic is duplicated here.
 */
export class MisMediaRendererClient {
  readonly baseUrl:string;
  private readonly token:string;

  constructor(
    baseUrl=process.env.NEXUS_VIDEO_SERVER_URL ?? process.env.NEXUS_AVATAR_SERVER_URL ?? '',
    token=process.env.NEXUS_VIDEO_SERVER_TOKEN ?? process.env.NEXUS_AVATAR_SERVER_TOKEN ?? '',
  ){
    this.baseUrl=baseUrl.trim().replace(/\/$/,'');
    this.token=token.trim();
  }

  configured():boolean { return Boolean(this.baseUrl); }

  private headers():HeadersInit {
    return this.token ? {authorization:`Bearer ${this.token}`} : {};
  }

  async health():Promise<MisMediaHealth>{
    if(!this.configured()) return {configured:false,ok:false,message:'NEXUS_VIDEO_SERVER_URL is not configured'};
    try{
      const response=await fetch(`${this.baseUrl}/health`,{
        headers:this.headers(),
        signal:AbortSignal.timeout(7000),
      });
      const body=await response.json().catch(()=>({})) as {
        ok?:boolean;provider?:string;version?:string;gpu?:unknown;message?:string;
      };
      return {
        configured:true,
        ok:response.ok && body.ok!==false,
        provider:body.provider,
        version:body.version,
        gpu:body.gpu,
        message:response.ok ? body.message : body.message || `Media engine HTTP ${response.status}`,
      };
    }catch(error){
      return {configured:true,ok:false,message:error instanceof Error?error.message:'Media engine unreachable'};
    }
  }

  async render(input:MisMediaRenderInput):Promise<{data:Buffer;contentType:string;engine?:string}>{
    if(!this.configured()) throw new Error('Miś media renderer is not configured');
    if(!input.sourceImageBase64) throw new Error('sourceImageBase64 is required');
    if(!input.audioBase64) throw new Error('audioBase64 is required');

    const form=new FormData();
    form.append('source_image',new Blob(
      [new Uint8Array(decodeBase64(input.sourceImageBase64))],
      {type:input.sourceImageMime || 'image/png'},
    ),'bear.png');
    form.append('audio',new Blob(
      [new Uint8Array(decodeBase64(input.audioBase64))],
      {type:input.audioMime || 'audio/wav'},
    ),'speech.wav');

    const fields:Record<string,string|number|undefined>={
      body_prompt:input.bodyPrompt,
      negative_prompt:input.negativePrompt,
      width:input.width,
      height:input.height,
      fps:input.fps,
      num_frames:input.numFrames,
      seed:input.seed,
      face_protect:input.faceProtect,
      feather:input.feather,
    };
    for(const [key,value] of Object.entries(fields)){
      if(value!==undefined) form.append(key,String(value));
    }

    const response=await fetch(`${this.baseUrl}/v1/avatar/render`,{
      method:'POST',
      headers:this.headers(),
      body:form,
      signal:AbortSignal.timeout(90*60*1000),
    });
    if(!response.ok){
      const text=await response.text().catch(()=>'');
      throw new Error(`Miś media render HTTP ${response.status}${text ? `: ${text.slice(0,500)}` : ''}`);
    }
    return {
      data:Buffer.from(await response.arrayBuffer()),
      contentType:response.headers.get('content-type') || 'video/mp4',
      engine:response.headers.get('x-nexus-engine') || undefined,
    };
  }
}
