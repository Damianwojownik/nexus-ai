import type { ModelProvider } from './modelRouter.ts';

export class HubCloudProvider implements ModelProvider {
  readonly name='Nexus Cloud Hub';
  readonly mode='CLOUD' as const;
  readonly role='PRIMARY_ORCHESTRATOR' as const;
  private readonly baseUrl:string;

  constructor(baseUrl = import.meta.env?.VITE_NEXUS_AGENT_HUB_URL || 'http://127.0.0.1:8788'){
    this.baseUrl=baseUrl.replace(/\/$/,'');
  }

  async checkHealth(){
    try{
      const r=await fetch(`${this.baseUrl}/api/ai/health`,{signal:AbortSignal.timeout(12000)});
      const body=await r.json().catch(()=>({})) as any;
      if(!r.ok) return {status:'ERROR' as const,error:body?.error||`HTTP ${r.status}`};
      return {
        status:body?.status==='CONNECTED'?'CONNECTED' as const:body?.status==='NOT_CONFIGURED'?'NO_MODEL' as const:body?.status==='ERROR'?'ERROR' as const:'OFFLINE' as const,
        model:Array.isArray(body?.providers)?body.providers.filter((p:any)=>p.status==='CONNECTED').map((p:any)=>p.name).join(' + '):undefined,
        models:body?.providers
      };
    }catch(e){
      return {status:'OFFLINE' as const,error:e instanceof Error?e.message:'Nexus Cloud Hub unavailable'};
    }
  }

  async listModels(){
    const h=await this.checkHealth();
    return Array.isArray(h.models)?h.models:[];
  }

  async generate(prompt:string, options:Record<string,any>={}){
    const r=await fetch(`${this.baseUrl}/api/ai/generate`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({prompt,...options}),
      signal:AbortSignal.timeout(130000)
    });
    const body=await r.json().catch(()=>({})) as any;
    if(!r.ok) throw new Error(body?.error||`Nexus Cloud Hub HTTP ${r.status}`);
    if(typeof body?.text!=='string'||!body.text.trim()) throw new Error('Nexus Cloud Hub returned an empty response');
    return body.text;
  }
}
