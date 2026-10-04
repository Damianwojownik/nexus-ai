import type { MisLanguage, PhonemeCue } from './types.ts';
import { acceptAlignedPhonemes, type AlignedPhoneInput } from './phonemeEngine.ts';

export type AlignmentRequest = {
  language: MisLanguage;
  transcript: string;
  audioBase64: string;
  audioMime?: string;
};

export type AlignmentHealth = {
  configured: boolean;
  ok: boolean;
  provider?: string;
  message?: string;
};

export interface PhonemeAligner {
  health(): Promise<AlignmentHealth>;
  align(input: AlignmentRequest): Promise<PhonemeCue[]>;
}

/**
 * Local HTTP adapter. This keeps clinical/phonetic timing independent from
 * renderer vendors. A future MFA/Whisper/CTC aligner can implement the same API.
 */
export class LocalPhonemeAligner implements PhonemeAligner {
  readonly baseUrl:string;
  private readonly token:string;

  constructor(
    baseUrl = process.env.MIS_ALIGNER_URL ?? '',
    token = process.env.MIS_ALIGNER_TOKEN ?? '',
  ){
    this.baseUrl=baseUrl.trim().replace(/\/$/,'');
    this.token=token.trim();
  }

  private headers():HeadersInit {
    return {
      'content-type':'application/json',
      ...(this.token ? {authorization:`Bearer ${this.token}`} : {}),
    };
  }

  async health():Promise<AlignmentHealth>{
    if(!this.baseUrl) return {configured:false,ok:false,message:'MIS_ALIGNER_URL is not configured'};
    try{
      const response=await fetch(`${this.baseUrl}/health`,{
        headers:this.token ? {authorization:`Bearer ${this.token}`} : undefined,
        signal:AbortSignal.timeout(5000),
      });
      if(!response.ok) return {configured:true,ok:false,message:`Aligner HTTP ${response.status}`};
      const body=await response.json() as {ok?:boolean;provider?:string;message?:string};
      return {configured:true,ok:body.ok===true,provider:body.provider,message:body.message};
    }catch(error){
      return {configured:true,ok:false,message:error instanceof Error?error.message:'Aligner unreachable'};
    }
  }

  async align(input:AlignmentRequest):Promise<PhonemeCue[]>{
    if(!this.baseUrl) throw new Error('MIS_ALIGNER_URL is not configured');
    if(!input.transcript.trim()) throw new Error('transcript is required');
    if(!input.audioBase64) throw new Error('audioBase64 is required');

    const response=await fetch(`${this.baseUrl}/v1/align`,{
      method:'POST',
      headers:this.headers(),
      body:JSON.stringify(input),
      signal:AbortSignal.timeout(5*60*1000),
    });
    if(!response.ok){
      let detail=`Aligner HTTP ${response.status}`;
      try{
        const body=await response.json() as {error?:string;detail?:string};
        detail=body.error||body.detail||detail;
      }catch{}
      throw new Error(detail);
    }
    const body=await response.json() as {phones?:AlignedPhoneInput[]};
    if(!Array.isArray(body.phones)) throw new Error('Aligner response has no phones[]');
    const aligned=acceptAlignedPhonemes(body.phones);
    if(!aligned.length) throw new Error('Aligner returned no valid phoneme timing');
    return aligned;
  }
}
