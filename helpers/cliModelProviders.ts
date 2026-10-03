import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type CliHealth={
  status:'CONNECTED'|'OFFLINE'|'ERROR';
  version?:string;
  error?:string;
};

type CliOptions={cwdName:string;timeoutMs?:number};

class SafeCliRunner{
  private readonly cwd:string;
  private readonly timeoutMs:number;
  constructor(options:CliOptions){
    const localData=process.env.LOCALAPPDATA||process.cwd();
    this.cwd=join(localData,'NexusAI',options.cwdName);
    this.timeoutMs=options.timeoutMs??120000;
  }
  private async ensure(){await mkdir(this.cwd,{recursive:true});}
  async run(command:string,args:string[],timeoutMs=this.timeoutMs):Promise<{stdout:string;stderr:string}>{
    await this.ensure();
    return new Promise((resolve,reject)=>{
      const finish=(error:Error|null,stdout:string,stderr:string)=>{
        if(error) reject(new Error((stderr||error.message||`${command} failed`).trim()));
        else resolve({stdout:stdout.trim(),stderr:stderr.trim()});
      };
      if(process.platform==='win32'){
        const encodedArgs=Buffer.from(JSON.stringify(args),'utf8').toString('base64');
        const encodedCmd=Buffer.from(`${command}.cmd`,'utf8').toString('base64');
        const script=[
          "$ErrorActionPreference='Stop'",
          `$cmd=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedCmd}'))`,
          `$a=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedArgs}')) | ConvertFrom-Json`,
          '& $cmd @a',
          'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        ].join('; ');
        const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{
          cwd:this.cwd,timeout:timeoutMs,windowsHide:true,maxBuffer:8*1024*1024
        },finish);
        child.stdin?.end();
        return;
      }
      const child=execFile(command,args,{cwd:this.cwd,timeout:timeoutMs,maxBuffer:8*1024*1024},finish);
      child.stdin?.end();
    });
  }
}

export class CodexCliProvider{
  readonly id='codex-cli';
  readonly name='OpenAI Codex CLI';
  private readonly runner=new SafeCliRunner({cwdName:'codex-runtime'});
  async checkHealth():Promise<CliHealth>{
    try{
      const r=await this.runner.run('codex',['--version'],10000);
      return {status:'CONNECTED',version:r.stdout||r.stderr||'installed'};
    }catch(e){
      return {status:'OFFLINE',error:e instanceof Error?e.message:'Codex CLI unavailable'};
    }
  }
  async generate(prompt:string):Promise<string>{
    const normalized=prompt.trim();
    if(!normalized) throw new Error('Prompt is required');
    if(normalized.length>60000) throw new Error('Prompt is too large for Codex CLI bridge');
    const r=await this.runner.run('codex',['exec','--sandbox','read-only','--skip-git-repo-check',normalized],180000);
    if(!r.stdout) throw new Error(r.stderr||'Codex CLI returned an empty response');
    return r.stdout;
  }
}

export class ClaudeCliProvider{
  readonly id='claude-cli';
  readonly name='Claude Code CLI';
  private readonly runner=new SafeCliRunner({cwdName:'claude-runtime'});
  async checkHealth():Promise<CliHealth>{
    try{
      const r=await this.runner.run('claude',['--version'],10000);
      return {status:'CONNECTED',version:r.stdout||r.stderr||'installed'};
    }catch(e){
      return {status:'OFFLINE',error:e instanceof Error?e.message:'Claude Code CLI unavailable'};
    }
  }
  async generate(prompt:string):Promise<string>{
    const normalized=prompt.trim();
    if(!normalized) throw new Error('Prompt is required');
    if(normalized.length>60000) throw new Error('Prompt is too large for Claude Code bridge');
    const r=await this.runner.run('claude',[
      '-p',normalized,
      '--output-format','text',
      '--max-turns','1',
      '--permission-mode','plan'
    ],180000);
    if(!r.stdout) throw new Error(r.stderr||'Claude Code returned an empty response');
    return r.stdout;
  }
}
