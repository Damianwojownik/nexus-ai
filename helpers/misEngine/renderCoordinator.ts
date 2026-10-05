import { SelfHostedAvatarServerClient, type AvatarRenderResult } from '../selfHostedAvatarServer.ts';
import { MisMediaRendererClient } from './mediaRenderer.ts';
import type { MisRenderMode, MisRendererId } from './rendererRegistry.ts';
import type { ArticulationControlPoint } from './types.ts';

export type MisRenderInput = {
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
  articulationControls?:ArticulationControlPoint[];
  articulationStrength?:number;
};

export type MisRenderOutput = {
  renderer:MisRendererId;
  contentType:string;
  data:Buffer;
  fallbackUsed:boolean;
  engine?:string;
};

type LiveRenderer = Pick<SelfHostedAvatarServerClient,'configured'|'render'|'health'>;
type QualityRenderer = Pick<MisMediaRendererClient,'configured'|'render'|'health'>;

/**
 * TEST / EXPERIMENTAL renderer coordinator.
 *
 * Miś control data stays vendor-independent. This class only selects the
 * visual renderer. It never changes phoneme/articulation/haptic timing.
 */
export class MisRenderCoordinator {
  private readonly live: LiveRenderer;
  private readonly quality: QualityRenderer;

  constructor(
    live:LiveRenderer=new SelfHostedAvatarServerClient(),
    quality:QualityRenderer=new MisMediaRendererClient(),
  ){
    this.live = live;
    this.quality = quality;
  }

  async health():Promise<{
    experimental:true;
    live:Awaited<ReturnType<LiveRenderer['health']>>;
    quality:Awaited<ReturnType<QualityRenderer['health']>>;
  }>{
    const [live,quality]=await Promise.all([this.live.health(),this.quality.health()]);
    return {experimental:true,live,quality};
  }

  async render(mode:MisRenderMode,input:MisRenderInput):Promise<MisRenderOutput>{
    if(!input.sourceImageBase64) throw new Error('sourceImageBase64 is required');
    if(!input.audioBase64) throw new Error('audioBase64 is required');

    if(mode==='quality' && this.quality.configured()){
      const rendered=await this.quality.render({
        sourceImageBase64:input.sourceImageBase64,
        sourceImageMime:input.sourceImageMime,
        audioBase64:input.audioBase64,
        audioMime:input.audioMime,
        bodyPrompt:input.bodyPrompt,
        negativePrompt:input.negativePrompt,
        width:input.width,
        height:input.height,
        fps:input.fps,
        numFrames:input.numFrames,
        seed:input.seed,
        articulationControls:input.articulationControls,
        articulationStrength:input.articulationStrength,
      });
      return {
        renderer:'nexus-media-flp-ltx',
        contentType:rendered.contentType,
        data:rendered.data,
        fallbackUsed:false,
        engine:rendered.engine,
      };
    }

    if(!this.live.configured()){
      throw new Error(
        mode==='quality'
          ? 'Quality renderer is unavailable and live FasterLivePortrait fallback is not configured'
          : 'Live FasterLivePortrait renderer is not configured',
      );
    }

    const rendered:AvatarRenderResult=await this.live.render({
      sourceImageBase64:input.sourceImageBase64,
      sourceImageMime:input.sourceImageMime,
      audioBase64:input.audioBase64,
      audioMime:input.audioMime,
      subjectMode:'animal',
      articulationControls:input.articulationControls,
      articulationStrength:input.articulationStrength,
    });
    return {
      renderer:'faster-liveportrait',
      contentType:rendered.contentType,
      data:rendered.data,
      fallbackUsed:mode==='quality',
    };
  }
}
