import type { AgentHubClient } from '../agentHubClient.ts';
import { buildEstimatedPhonemeTimeline } from './phonemeEngine.ts';
import { sampleMisRuntime, type MisRuntimeFrame } from './runtime.ts';
import type { MisLanguage, PhonemeCue } from './types.ts';

type MisHub = Pick<AgentHubClient,'alignMisSpeech'|'renderMis'>;

export type MisSessionInput = {
  language:MisLanguage;
  transcript:string;
  sourceImageBase64:string;
  sourceImageMime?:string;
  audioBase64:string;
  audioMime?:string;
  renderMode?:'live'|'quality';
  bodyPrompt?:string;
  negativePrompt?:string;
  width?:number;
  height?:number;
  fps?:number;
  numFrames?:number;
  seed?:number;
  controlFps?:number;
  allowEstimatedFallback?:boolean;
};

export type MisSessionResult = {
  experimental:true;
  alignment:'aligned-audio'|'estimated-text-fallback';
  alignmentError?:string;
  phones:PhonemeCue[];
  frames:MisRuntimeFrame[];
  video:Blob;
  renderer?:string;
  fallbackRendererUsed:boolean;
  engine?:string;
};

/**
 * High-level Miś Engine pipeline.
 *
 * One source audio feeds both the visual renderer and phoneme alignment.
 * The aligned timeline then drives articulation, Nexus motion and haptics on
 * one clock. Estimated timing is opt-in fallback only.
 */
export async function runMisSession(
  hub:MisHub,
  input:MisSessionInput,
):Promise<MisSessionResult>{
  if(!input.transcript.trim()) throw new Error('transcript is required');
  if(!input.sourceImageBase64) throw new Error('sourceImageBase64 is required');
  if(!input.audioBase64) throw new Error('audioBase64 is required');

  const renderPromise=hub.renderMis({
    mode:input.renderMode ?? 'live',
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
  });

  let phones:PhonemeCue[];
  let alignment:'aligned-audio'|'estimated-text-fallback'='aligned-audio';
  let alignmentError:string|undefined;

  try{
    const aligned=await hub.alignMisSpeech({
      language:input.language,
      transcript:input.transcript,
      audioBase64:input.audioBase64,
      audioMime:input.audioMime,
    });
    phones=aligned.phones;
  }catch(error){
    if(!input.allowEstimatedFallback){
      // Do not silently downgrade a speech-training run to guessed timings.
      await renderPromise.catch(()=>undefined);
      throw error;
    }
    alignment='estimated-text-fallback';
    alignmentError=error instanceof Error ? error.message : String(error);
    phones=buildEstimatedPhonemeTimeline(input.transcript,input.language);
  }

  const rendered=await renderPromise;
  const frames=sampleMisRuntime(
    phones,
    input.language,
    Math.max(10,Math.min(60,input.controlFps ?? 50)),
    'SPEAKING',
  );

  return {
    experimental:true,
    alignment,
    alignmentError,
    phones,
    frames,
    video:rendered.blob,
    renderer:rendered.renderer,
    fallbackRendererUsed:rendered.fallbackUsed,
    engine:rendered.engine,
  };
}
