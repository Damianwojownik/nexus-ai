import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER='https://auth.openai.com';
const AUTHORIZE_URL='https://auth.openai.com/api/accounts/authorize';
const TOKEN_URL='https://auth.openai.com/api/accounts/oauth/token';
const JWKS_URL='https://auth.openai.com/.well-known/jwks.json';
const RESOURCE='https://api.openai.com/v1';
const REQUIRED_SCOPE='chatgpt.tokens.use.direct';
const REQUESTED_SCOPES='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

type StoredProfile={
  email?:string;
  name?:string;
  issuer:string;
  subject:string;
  client_id:string;
  ext_agent_host_id:string;
  id_token:string;
  access_token:string;
  refresh_token:string;
  token_type:string;
  expires_in:number;
  earliest_refresh_at?:number;
  scopes:string[];
  saved_at:string;
};

type PendingAuth={
  state:string;
  nonce:string;
  verifier:string;
  redirectUri:string;
  clientId:string;
  initial:boolean;
  expiresAt:number;
};

export type ChatGptPlanStatus={
  connected:boolean;
  planUsageEnabled:boolean;
  email?:string;
  clientId?:string;
  model?:string;
  models?:Array<{slug:string;displayName:string}>;
  error?:string;
};

function appDataDir(){
  return process.env.NEXUS_CHATGPT_PLAN_DIR
    || (process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA,'NexusAI')
      : join(homedir(),'.config','nexus-ai'));
}

function b64url(bytes=32){
  return randomBytes(bytes).toString('base64url');
}

function parseScopes(scope:unknown):string[]{
  return typeof scope==='string'
    ? scope.split(/\s+/).map(x=>x.trim()).filter(Boolean)
    : [];
}

async function writeProtectedJson(path:string,value:unknown){
  await mkdir(dirname(path),{recursive:true});
  const tmp=path+'.tmp';
  await writeFile(tmp,JSON.stringify(value,null,2),'utf8');
  try{await chmod(tmp,0o600)}catch{}
  await rename(tmp,path);
  try{await chmod(path,0o600)}catch{}
}

export class ChatGptPlanProvider{
  readonly id='chatgpt-plan' as const;
  readonly name='ChatGPT plan';
  private pending?:PendingAuth;
  private readonly profilePath=join(appDataDir(),'chatgpt-plan.json');
  private readonly hostPath=join(appDataDir(),'chatgpt-host.json');
  private readonly jwks=createRemoteJWKSet(new URL(JWKS_URL));

  private redirectUri(){
    const port=Number(process.env.NEXUS_AGENT_HUB_PORT??8788);
    return `http://127.0.0.1:${port}/auth/callback`;
  }

  private async loadProfile():Promise<StoredProfile|undefined>{
    try{
      const value=JSON.parse(await readFile(this.profilePath,'utf8')) as StoredProfile;
      return value&&typeof value.client_id==='string'&&typeof value.access_token==='string'
        ? value
        : undefined;
    }catch{return undefined}
  }

  private async hostId(){
    try{
      const stored=JSON.parse(await readFile(this.hostPath,'utf8')) as {ext_agent_host_id?:unknown};
      if(typeof stored.ext_agent_host_id==='string'&&stored.ext_agent_host_id.trim()){
        return stored.ext_agent_host_id.trim();
      }
    }catch{}
    const ext_agent_host_id='urn:uuid:'+randomUUID();
    await writeProtectedJson(this.hostPath,{ext_agent_host_id});
    return ext_agent_host_id;
  }

  async startAuthorization(){
    const profile=await this.loadProfile();
    const extAgentHostId=await this.hostId();
    const state=b64url(32);
    const nonce=b64url(32);
    const verifier=b64url(64);
    const challenge=createHash('sha256').update(verifier).digest('base64url');
    const redirectUri=this.redirectUri();
    const clientId=profile?.client_id||'dynamic_agent_client';
    this.pending={
      state,nonce,verifier,redirectUri,clientId,
      initial:!profile,
      expiresAt:Date.now()+10*60_000,
    };

    const url=new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id',clientId);
    if(!profile)url.searchParams.set('agent_name_hint','Nexus');
    url.searchParams.set('ext_agent_host_id',extAgentHostId);
    if(profile?.id_token)url.searchParams.set('id_token_hint',profile.id_token);
    if(profile?.email)url.searchParams.set('login_hint',profile.email);
    url.searchParams.set('response_type','code');
    url.searchParams.set('redirect_uri',redirectUri);
    url.searchParams.set('scope',REQUESTED_SCOPES);
    url.searchParams.set('resource',RESOURCE);
    url.searchParams.set('state',state);
    url.searchParams.set('nonce',nonce);
    url.searchParams.set('code_challenge_method','S256');
    url.searchParams.set('code_challenge',challenge);
    return{authorizationUrl:url.toString(),returning:Boolean(profile)};
  }

  async handleCallback(callbackUrl:URL){
    const pending=this.pending;
    this.pending=undefined;
    if(!pending||Date.now()>pending.expiresAt)throw new Error('ChatGPT sign-in expired. Start again.');
    if(callbackUrl.searchParams.get('state')!==pending.state)throw new Error('ChatGPT sign-in state mismatch.');
    const oauthError=callbackUrl.searchParams.get('error');
    if(oauthError)throw new Error('ChatGPT sign-in was not completed: '+oauthError);
    const code=callbackUrl.searchParams.get('code');
    if(!code)throw new Error('ChatGPT callback did not contain an authorization code.');

    const callbackClientId=callbackUrl.searchParams.get('client_id');
    const issuedClientId=pending.initial
      ? callbackClientId
      : pending.clientId;
    if(!issuedClientId)throw new Error('ChatGPT did not return an issued client_id.');
    if(!pending.initial&&callbackClientId&&callbackClientId!==pending.clientId){
      throw new Error('ChatGPT callback client_id mismatch.');
    }

    const body=new URLSearchParams({
      grant_type:'authorization_code',
      client_id:issuedClientId,
      code,
      code_verifier:pending.verifier,
      redirect_uri:pending.redirectUri,
      resource:RESOURCE,
    });
    const response=await fetch(TOKEN_URL,{
      method:'POST',
      headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},
      body,
      signal:AbortSignal.timeout(30_000),
    });
    const token:any=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(token?.error_description||token?.error||`ChatGPT token HTTP ${response.status}`);
    if(typeof token.id_token!=='string'||typeof token.access_token!=='string'||typeof token.refresh_token!=='string'){
      throw new Error('ChatGPT token response is incomplete.');
    }

    const {payload}=await jwtVerify(token.id_token,this.jwks,{
      issuer:ISSUER,
      audience:issuedClientId,
      requiredClaims:['sub','exp','iat'],
      clockTolerance:5,
    });
    if(payload.nonce!==pending.nonce)throw new Error('ChatGPT ID token nonce mismatch.');
    if(typeof payload.sub!=='string'||!payload.sub)throw new Error('ChatGPT ID token has no subject.');

    const scopes=parseScopes(token.scope);
    const profile:StoredProfile={
      email:typeof payload.email==='string'?payload.email:undefined,
      name:typeof payload.name==='string'?payload.name:undefined,
      issuer:ISSUER,
      subject:payload.sub,
      client_id:issuedClientId,
      ext_agent_host_id:await this.hostId(),
      id_token:token.id_token,
      access_token:token.access_token,
      refresh_token:token.refresh_token,
      token_type:typeof token.token_type==='string'?token.token_type:'Bearer',
      expires_in:Number(token.expires_in)||3600,
      earliest_refresh_at:typeof token.earliest_refresh_at==='number'?token.earliest_refresh_at:undefined,
      scopes,
      saved_at:new Date().toISOString(),
    };
    await writeProtectedJson(this.profilePath,profile);
    return{
      connected:true,
      planUsageEnabled:scopes.includes(REQUIRED_SCOPE),
      email:profile.email,
      clientId:profile.client_id,
    };
  }

  async signOut(){
    this.pending=undefined;
    await rm(this.profilePath,{force:true});
  }

  private async ensureAccessToken():Promise<StoredProfile>{
    let profile=await this.loadProfile();
    if(!profile)throw new Error('ChatGPT plan is not connected.');
    if(!profile.scopes.includes(REQUIRED_SCOPE))throw new Error('ChatGPT plan usage permission is not enabled.');

    const savedAt=Date.parse(profile.saved_at);
    const expiresAt=(Number.isFinite(savedAt)?savedAt:0)+profile.expires_in*1000;
    if(Date.now()<expiresAt-120_000)return profile;

    const body=new URLSearchParams({
      grant_type:'refresh_token',
      client_id:profile.client_id,
      refresh_token:profile.refresh_token,
      resource:RESOURCE,
    });
    const response=await fetch(TOKEN_URL,{
      method:'POST',
      headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},
      body,
      signal:AbortSignal.timeout(30_000),
    });
    const token:any=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(token?.error_description||token?.error||`ChatGPT refresh HTTP ${response.status}`);
    if(typeof token.access_token!=='string'||typeof token.refresh_token!=='string'){
      throw new Error('ChatGPT refresh response is incomplete.');
    }
    profile={
      ...profile,
      access_token:token.access_token,
      refresh_token:token.refresh_token,
      id_token:typeof token.id_token==='string'?token.id_token:profile.id_token,
      token_type:typeof token.token_type==='string'?token.token_type:profile.token_type,
      expires_in:Number(token.expires_in)||3600,
      earliest_refresh_at:typeof token.earliest_refresh_at==='number'?token.earliest_refresh_at:profile.earliest_refresh_at,
      scopes:parseScopes(token.scope).length?parseScopes(token.scope):profile.scopes,
      saved_at:new Date().toISOString(),
    };
    await writeProtectedJson(this.profilePath,profile);
    return profile;
  }

  async listModels():Promise<Array<{slug:string;displayName:string}>>{
    const profile=await this.ensureAccessToken();
    const response=await fetch('https://api.openai.com/v1/models',{
      headers:{authorization:'Bearer '+profile.access_token,accept:'application/json'},
      signal:AbortSignal.timeout(20_000),
    });
    const data:any=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data?.error?.message||`ChatGPT models HTTP ${response.status}`);
    const models=Array.isArray(data?.models)?data.models:[];
    return models
      .filter((item:any)=>item&&item.visibility==='list'&&typeof item.slug==='string')
      .map((item:any)=>({
        slug:item.slug as string,
        displayName:typeof item.display_name==='string'?item.display_name:item.slug,
      }));
  }

  async status():Promise<ChatGptPlanStatus>{
    const profile=await this.loadProfile();
    if(!profile)return{connected:false,planUsageEnabled:false};
    const planUsageEnabled=profile.scopes.includes(REQUIRED_SCOPE);
    if(!planUsageEnabled)return{
      connected:true,planUsageEnabled:false,email:profile.email,clientId:profile.client_id,
      error:'ChatGPT plan usage permission is not enabled.',
    };
    try{
      const models=await this.listModels();
      const preferred=(process.env.NEXUS_CHATGPT_PLAN_MODEL||'').trim();
      const model=models.some(item=>item.slug===preferred)?preferred:models[0]?.slug;
      return{
        connected:true,planUsageEnabled:true,email:profile.email,clientId:profile.client_id,
        model,models:models.slice(0,20),
      };
    }catch(error){
      return{
        connected:true,planUsageEnabled:true,email:profile.email,clientId:profile.client_id,
        error:error instanceof Error?error.message:'ChatGPT plan status failed',
      };
    }
  }

  async health(){
    const status=await this.status();
    if(!status.connected)return{id:this.id,name:this.name,status:'NOT_CONFIGURED' as const};
    if(!status.planUsageEnabled)return{id:this.id,name:this.name,status:'ERROR' as const,error:status.error};
    if(status.error)return{id:this.id,name:this.name,status:'OFFLINE' as const,model:status.model,error:status.error};
    return{id:this.id,name:this.name,status:'CONNECTED' as const,model:status.model};
  }

  async generate(prompt:string){
    const profile=await this.ensureAccessToken();
    const models=await this.listModels();
    const preferred=(process.env.NEXUS_CHATGPT_PLAN_MODEL||'').trim();
    const model=models.some(item=>item.slug===preferred)?preferred:models[0]?.slug;
    if(!model)throw new Error('ChatGPT plan returned no available model.');

    const response=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{
        authorization:'Bearer '+profile.access_token,
        'content-type':'application/json',
        accept:'text/event-stream',
      },
      body:JSON.stringify({
        model,
        input:[{role:'user',content:prompt}],
        store:false,
        stream:true,
      }),
      signal:AbortSignal.timeout(180_000),
    });
    if(!response.ok){
      const text=await response.text();
      throw new Error(`ChatGPT plan HTTP ${response.status}: ${text.slice(0,600)}`);
    }
    if(!response.body)throw new Error('ChatGPT plan returned no response stream.');

    const reader=response.body.getReader();
    const decoder=new TextDecoder();
    let buffer='';
    let output='';
    let completed=false;
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      let split:number;
      while((split=buffer.indexOf('\n\n'))>=0){
        const block=buffer.slice(0,split);
        buffer=buffer.slice(split+2);
        const data=block.split(/\r?\n/)
          .filter(line=>line.startsWith('data:'))
          .map(line=>line.slice(5).trim())
          .join('\n');
        if(!data||data==='[DONE]')continue;
        let event:any;
        try{event=JSON.parse(data)}catch{continue}
        if(event?.type==='response.output_text.delta'&&typeof event.delta==='string'){
          output+=event.delta;
        }else if(event?.type==='response.failed'){
          const code=event?.response?.error?.code||'unknown_error';
          throw new Error('ChatGPT plan response failed: '+code);
        }else if(event?.type==='response.incomplete'){
          throw new Error('ChatGPT plan response was incomplete.');
        }else if(event?.type==='response.completed'){
          completed=true;
        }
      }
    }
    if(!completed)throw new Error('ChatGPT plan stream ended before response.completed.');
    if(!output.trim())throw new Error('ChatGPT plan returned an empty response.');
    return{text:output.trim(),provider:'ChatGPT plan',model};
  }
}
