export interface ProjectBlueprint {
  name: string;
  summary: string;
  stack: string;
  features: string[];
}

export interface GeneratedProjectFile {
  path: string;
  content: string;
}

export interface GeneratedProject {
  name: string;
  summary: string;
  files: GeneratedProjectFile[];
}

const allowedExtensions = new Set([
  '.html','.css','.js','.jsx','.ts','.tsx','.json','.md','.txt','.svg','.yml','.yaml','.toml'
]);

export function isProjectCreationIntent(text: string): boolean {
  return /\b(stw[oó]rz|zbuduj|zaprojektuj|napisz|zr[oó]b)\b.{0,80}\b(aplikacj|app|stron|serwis|panel|dashboard|program|projekt|frontend|backend|api)\b/i.test(text)
    || /\b(chc[eę]\s+(?:mie[cć]|zrobi[cć])\s+(?:aplikacj[eę]|app|program|stron[eę]))\b/i.test(text);
}

export function needsProjectClarification(text: string): boolean {
  const compact = text.trim().replace(/\s+/g,' ');
  if (compact.length < 24) return true;
  return /^(?:chc[eę]|zr[oó]b|stw[oó]rz|zbuduj)\s+(?:mi\s+)?(?:aplikacj[eę]|app|program|stron[eę])\.?$/i.test(compact);
}

export function isAffirmative(text: string): boolean {
  return /^(tak|tak\s+zr[oó]b|zr[oó]b|dzia[lł]aj|ok|okej|yes|potwierdzam|zgoda)[.!\s]*$/i.test(text.trim());
}

export function safeProjectName(value: string): string {
  const normalized=value.trim().toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9-_ ]/g,'').replace(/\s+/g,'-')
    .replace(/-+/g,'-').replace(/^[-_.]+|[-_.]+$/g,'')
    .slice(0,48);
  return normalized || 'nexus-project';
}

export function validateGeneratedProject(project: GeneratedProject): GeneratedProject {
  const name=safeProjectName(project.name);
  if (!project || typeof project.summary!=='string' || !Array.isArray(project.files)) throw new Error('Invalid generated project');
  if (project.files.length<1 || project.files.length>24) throw new Error('Generated project must contain 1-24 files');
  let total=0;
  const seen=new Set<string>();
  const files=project.files.map((file)=>{
    if (!file || typeof file.path!=='string' || typeof file.content!=='string') throw new Error('Invalid generated project file');
    const path=file.path.replace(/\\/g,'/').replace(/^\.\//,'');
    if (!path || path.startsWith('/') || path.includes('..') || path.startsWith('.git/') || path.includes('/.git/')) throw new Error(`Unsafe project path: ${file.path}`);
    const dot=path.lastIndexOf('.');
    const ext=dot>=0?path.slice(dot).toLowerCase():'';
    const base=path.split('/').pop() || '';
    const allowedBase=base==='package.json' || base==='vite.config.ts' || base==='vite.config.js' || base==='tsconfig.json';
    if (!allowedBase && !allowedExtensions.has(ext)) throw new Error(`Unsupported generated file type: ${path}`);
    if (seen.has(path.toLowerCase())) throw new Error(`Duplicate generated path: ${path}`);
    seen.add(path.toLowerCase());
    const bytes=new TextEncoder().encode(file.content).byteLength;
    if (bytes>128*1024) throw new Error(`Generated file is too large: ${path}`);
    total+=bytes;
    return {path,content:file.content};
  });
  if(total>768*1024) throw new Error('Generated project exceeds 768 KB safety limit');
  return {name,summary:project.summary.trim().slice(0,1200),files};
}

export function parseBlueprint(text: string): ProjectBlueprint {
  const raw=text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start=raw.indexOf('{'),end=raw.lastIndexOf('}');
  if(start<0||end<=start) throw new Error('Model did not return a project blueprint');
  const data=JSON.parse(raw.slice(start,end+1)) as any;
  if(typeof data.name!=='string'||typeof data.summary!=='string'||typeof data.stack!=='string'||!Array.isArray(data.features)) throw new Error('Invalid project blueprint');
  return {
    name:safeProjectName(data.name),
    summary:data.summary.trim().slice(0,1000),
    stack:data.stack.trim().slice(0,200),
    features:data.features.filter((x:any)=>typeof x==='string').slice(0,12),
  };
}

export function parseGeneratedProject(text: string): GeneratedProject {
  const raw=text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start=raw.indexOf('{'),end=raw.lastIndexOf('}');
  if(start<0||end<=start) throw new Error('Model did not return project files');
  return validateGeneratedProject(JSON.parse(raw.slice(start,end+1)) as GeneratedProject);
}
