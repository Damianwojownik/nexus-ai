import { CopilotCliProvider } from './copilotCliProvider.ts';

export type CloudProviderHealth = {
  id: 'copilot' | 'openai' | 'claude';
  name: string;
  status: 'CONNECTED' | 'NOT_CONFIGURED' | 'OFFLINE' | 'ERROR';
  model?: string;
  error?: string;
};

export type CloudGenerateResult = {
  text: string;
  provider: string;
  model?: string;
};

function env(name:string):string {
  return (process.env[name] ?? '').trim();
}

class OpenAIProvider {
  readonly id='openai' as const;
  readonly name='OpenAI';
  readonly key=env('OPENAI_API_KEY') || env('NEXUS_OPENAI_API_KEY');
  readonly model=env('NEXUS_OPENAI_MODEL') || 'gpt-5.6';

  configured(){ return !!this.key; }

  async health():Promise<CloudProviderHealth>{
    if(!this.configured()) return {id:this.id,name:this.name,status:'NOT_CONFIGURED',model:this.model};
    try{
      const r=await fetch('https://api.openai.com/v1/models',{
        headers:{Authorization:`Bearer ${this.key}`},
        signal:AbortSignal.timeout(12000)
      });
      if(!r.ok) return {id:this.id,name:this.name,status:'ERROR',model:this.model,error:`HTTP ${r.status}`};
      return {id:this.id,name:this.name,status:'CONNECTED',model:this.model};
    }catch(e){
      return {id:this.id,name:this.name,status:'OFFLINE',model:this.model,error:e instanceof Error?e.message:'OpenAI unavailable'};
    }
  }

  async generate(prompt:string, options:Record<string,any>={}):Promise<CloudGenerateResult>{
    if(!this.configured()) throw new Error('OpenAI is not configured');
    const body:any={
      model:this.model,
      input:prompt,
    };
    if(typeof options.maxOutputTokens==='number') body.max_output_tokens=options.maxOutputTokens;
    if(typeof options.temperature==='number') body.temperature=options.temperature;
    const r=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{Authorization:`Bearer ${this.key}`,'Content-Type':'application/json',Accept:'application/json'},
      body:JSON.stringify(body),
      signal:AbortSignal.timeout(120000)
    });
    const data=await r.json().catch(()=>({})) as any;
    if(!r.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${r.status}`);
    const text=typeof data?.output_text==='string'
      ? data.output_text
      : Array.isArray(data?.output)
        ? data.output.flatMap((item:any)=>Array.isArray(item?.content)?item.content:[]).map((part:any)=>part?.text).filter((x:any)=>typeof x==='string').join('')
        : '';
    if(!text.trim()) throw new Error('OpenAI returned an empty response');
    return {text,provider:this.name,model:this.model};
  }
}

class ClaudeProvider {
  readonly id='claude' as const;
  readonly name='Claude';
  readonly key=env('ANTHROPIC_API_KEY') || env('NEXUS_ANTHROPIC_API_KEY');
  readonly model=env('NEXUS_CLAUDE_MODEL') || 'claude-sonnet-4-5';

  configured(){ return !!this.key; }

  async health():Promise<CloudProviderHealth>{
    if(!this.configured()) return {id:this.id,name:this.name,status:'NOT_CONFIGURED',model:this.model};
    try{
      const r=await fetch('https://api.anthropic.com/v1/models',{
        headers:{'x-api-key':this.key,'anthropic-version':'2023-06-01'},
        signal:AbortSignal.timeout(12000)
      });
      if(!r.ok) return {id:this.id,name:this.name,status:'ERROR',model:this.model,error:`HTTP ${r.status}`};
      return {id:this.id,name:this.name,status:'CONNECTED',model:this.model};
    }catch(e){
      return {id:this.id,name:this.name,status:'OFFLINE',model:this.model,error:e instanceof Error?e.message:'Claude unavailable'};
    }
  }

  async generate(prompt:string, options:Record<string,any>={}):Promise<CloudGenerateResult>{
    if(!this.configured()) throw new Error('Claude is not configured');
    const r=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'x-api-key':this.key,'anthropic-version':'2023-06-01','Content-Type':'application/json',Accept:'application/json'},
      body:JSON.stringify({
        model:this.model,
        max_tokens:typeof options.maxOutputTokens==='number'?options.maxOutputTokens:4096,
        temperature:typeof options.temperature==='number'?options.temperature:0.2,
        messages:[{role:'user',content:prompt}]
      }),
      signal:AbortSignal.timeout(120000)
    });
    const data=await r.json().catch(()=>({})) as any;
    if(!r.ok) throw new Error(data?.error?.message || `Claude HTTP ${r.status}`);
    const text=Array.isArray(data?.content)?data.content.map((x:any)=>x?.type==='text'?x.text:'').join(''):'';
    if(!text.trim()) throw new Error('Claude returned an empty response');
    return {text,provider:this.name,model:this.model};
  }
}

export class NexusCloudRouter {
  private readonly copilot=new CopilotCliProvider();
  private readonly openai=new OpenAIProvider();
  private readonly claude=new ClaudeProvider();

  private order(){
    const configured=(env('NEXUS_AI_PROVIDER_ORDER') || 'copilot,openai,claude')
      .split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
    const valid=configured.filter((x):x is 'copilot'|'openai'|'claude'=>x==='copilot'||x==='openai'||x==='claude');
    return valid.length?valid:['copilot','openai','claude'];
  }

  async health():Promise<{status:'CONNECTED'|'OFFLINE'|'NOT_CONFIGURED'|'ERROR';providers:CloudProviderHealth[]}>{
    const [copilot,openai,claude]=await Promise.all([
      this.copilot.checkHealth().then(h=>({
        id:'copilot' as const,name:'GitHub Copilot CLI',
        status:h.status==='CONNECTED'?'CONNECTED' as const:h.status==='ERROR'?'ERROR' as const:'OFFLINE' as const,
        model:h.version,error:h.error
      })),
      this.openai.health(),
      this.claude.health()
    ]);
    const providers=[copilot,openai,claude];
    const status=providers.some(p=>p.status==='CONNECTED')
      ? 'CONNECTED'
      : providers.every(p=>p.status==='NOT_CONFIGURED')
        ? 'NOT_CONFIGURED'
        : providers.some(p=>p.status==='ERROR')
          ? 'ERROR'
          : 'OFFLINE';
    return {status,providers};
  }

  async generate(prompt:string, options:Record<string,any>={}):Promise<CloudGenerateResult>{
    const errors:string[]=[];
    for(const id of this.order()){
      try{
        if(id==='copilot'){
          const h=await this.copilot.checkHealth();
          if(h.status!=='CONNECTED'){ errors.push(`copilot: ${h.error||h.status}`); continue; }
          const text=await this.copilot.generate(prompt);
          if(text.trim()) return {text,provider:'GitHub Copilot CLI',model:h.version};
          errors.push('copilot: empty response');
          continue;
        }
        if(id==='openai'){
          const h=await this.openai.health();
          if(h.status!=='CONNECTED'){ errors.push(`openai: ${h.error||h.status}`); continue; }
          return await this.openai.generate(prompt,options);
        }
        if(id==='claude'){
          const h=await this.claude.health();
          if(h.status!=='CONNECTED'){ errors.push(`claude: ${h.error||h.status}`); continue; }
          return await this.claude.generate(prompt,options);
        }
      }catch(e){
        errors.push(`${id}: ${e instanceof Error?e.message:'failed'}`);
      }
    }
    throw new Error('No cloud provider succeeded. '+errors.join(' | '));
  }
}
