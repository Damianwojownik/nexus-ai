import type { AgentHubClient } from '../agentHubClient.ts';
import { buildEstimatedPhonemeTimeline } from './phonemeEngine.ts';
import { sampleMisRuntime, type MisRuntimeFrame } from './runtime.ts';
import type { ArticulationControlPoint, MisLanguage, PhonemeCue } from './types.ts';

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
  articulationStrength?:number;
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
      throw error;
    }
    alignment='estimated-text-fallback';
    alignmentError=error instanceof Error ? error.message : String(error);
    phones=buildEstimatedPhonemeTimeline(input.transcript,input.language);
  }

  const frames=sampleMisRuntime(
    phones,
    input.language,
    Math.max(10,Math.min(60,input.controlFps ?? 50)),
    'SPEAKING',
  );
  const articulationControls:ArticulationControlPoint[]=frames.map(frame=>({
    atMs:frame.atMs,
    jawOpen:frame.articulation.jawOpen,
    lipWide:frame.articulation.lipWide,
    lipRound:frame.articulation.lipRound,
    lipProtrusion:frame.articulation.lipProtrusion,
    lipPress:frame.articulation.lipPress,
  }));

  const rendered=await hub.renderMis({
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
    articulationControls,
    articulationStrength:Math.max(0,Math.min(1,input.articulationStrength ?? .35)),
  });

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
