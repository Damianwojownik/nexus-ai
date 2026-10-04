import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { AgentHub } from './agentHub.ts';
import { createTask } from './agentProtocol.ts';
import type { AgentKind, AgentResult, AgentTaskStatus } from './agentProtocol.ts';
import { LocalCapabilities, LocalCapabilityError } from './localCapabilities.ts';
import { SelfHostedAvatarServerClient } from './selfHostedAvatarServer.ts';
import { SelfHostedImageServerClient } from './selfHostedImageServer.ts';
import { NexusCloudRouter } from './cloudProviders.ts';
import { LocalPhonemeAligner } from './misEngine/phonemeAligner.ts';
import { MisRenderCoordinator } from './misEngine/renderCoordinator.ts';

const taskStatuses: AgentTaskStatus[] = ['TODO', 'WORKING', 'BLOCKED', 'DONE'];
const agentKinds: AgentKind[] = ['orchestrator', 'primary', 'codex', 'ollama', 'reviewer', 'researcher', 'memory', 'tool'];

export interface AgentHubServerOptions {
  allowedOrigins?: string[];
  workspaceDir?: string;
}

class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function sendHtml(response: ServerResponse, statusCode: number, html: string): void {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(html);
}

async function readJson(request: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, `Request body exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB`);
    chunks.push(buffer);
  }

  if (size === 0) return {};

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
  if (!isRecord(value)) throw new HttpError(400, 'Request body must be a JSON object');
  return value;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${key} is required`);
  }
  return value.trim();
}

function streamEvents(hub: AgentHub, request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const unsubscribe = hub.subscribe((event) => {
    if (response.destroyed) return;
    response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const keepAlive = setInterval(() => {
    if (!response.destroyed) response.write(': keep-alive\n\n');
  }, 15000);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    unsubscribe();
  };

  response.on('close', close);
  request.on('aborted', close);
  response.write('retry: 3000\n\n');
  response.flushHeaders();
}

function isAllowedOrigin(origin: string, configuredOrigins: string[]): boolean {
  if (configuredOrigins.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

function hubRelayHtml(targetOrigin: string): string {
  const encodedOrigin=JSON.stringify(targetOrigin);
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexus Local Hub</title>
<style>
body{font-family:system-ui;background:#07111d;color:#eaf7ff;margin:0;min-height:100vh;display:grid;place-items:center}
main{max-width:32rem;margin:1rem;padding:1.5rem;border:1px solid #26536d;border-radius:18px;background:#0c1a29}
h1{font-size:1.25rem;color:#7de4ff}p{line-height:1.5}.ok{color:#7dffc2}
</style>
</head>
<body><main>
<h1>Nexus Local Hub</h1>
<p class="ok">Połączenie lokalne gotowe.</p>
<p>Zostaw to małe okno otwarte podczas korzystania z Nexusa. Tokeny ChatGPT pozostają na tym komputerze.</p>
</main>
<script>
(() => {
  const TARGET_ORIGIN=${encodedOrigin};
  const openerWindow=window.opener;
  if(!openerWindow){ document.body.innerHTML='<main><h1>Brak okna Nexusa</h1><p>Otwórz ten most z przycisku w Nexusie.</p></main>'; return; }

  const send=(value)=>openerWindow.postMessage(value,TARGET_ORIGIN);
  const json=async(response)=>{
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data?.error||('Agent Hub HTTP '+response.status));
    return data;
  };

  window.addEventListener('message',async(event)=>{
    if(event.source!==openerWindow||event.origin!==TARGET_ORIGIN)return;
    const data=event.data;
    if(!data||data.type!=='nexus-hub-call'||typeof data.id!=='string')return;
    try{
      let result;
      switch(data.command){
        case 'health':
          result=await json(await fetch('/api/health',{headers:{Accept:'application/json'},cache:'no-store'}));
          break;
        case 'chatgpt_status':
          result=await json(await fetch('/api/chatgpt/status',{headers:{Accept:'application/json'},cache:'no-store'}));
          break;
        case 'chatgpt_signin':
          result=await json(await fetch('/api/chatgpt/sign-in/start',{
            method:'POST',headers:{'content-type':'application/json',Accept:'application/json'},body:'{}'
          }));
          break;
        case 'chatgpt_signout':
          result=await json(await fetch('/api/chatgpt/sign-out',{
            method:'POST',headers:{'content-type':'application/json',Accept:'application/json'},body:'{}'
          }));
          break;
        case 'generate':
          result=await json(await fetch('/api/ai/generate',{
            method:'POST',
            headers:{'content-type':'application/json',Accept:'application/json'},
            body:JSON.stringify(data.args||{}),
          }));
          break;
        default:
          throw new Error('Nieobsługiwana komenda Local Hub Relay.');
      }
      send({type:'nexus-hub-result',id:data.id,ok:true,result});
    }catch(error){
      send({
        type:'nexus-hub-result',
        id:data.id,
        ok:false,
        error:error instanceof Error?error.message:String(error),
      });
    }
  });

  send({type:'nexus-hub-ready',version:'1.0'});
  window.setInterval(()=>send({type:'nexus-hub-alive'}),5000);
})();
</script></body></html>`;
}

export function createAgentHubServer(hub: AgentHub, options: AgentHubServerOptions = {}): Server {
  const localCapabilities = new LocalCapabilities(options.workspaceDir ?? join(process.cwd(), 'workspace'));
  const avatarServer = new SelfHostedAvatarServerClient();
  const imageServer = new SelfHostedImageServerClient();
  const cloudRouter = new NexusCloudRouter();
  const misAligner = new LocalPhonemeAligner();
  const misRenderer = new MisRenderCoordinator();

  return createServer(async (request, response) => {
    const origin = request.headers.origin;
    const corsAllowed = !!origin && isAllowedOrigin(origin, options.allowedOrigins ?? []);
    if (corsAllowed) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type, Last-Event-ID');
      response.setHeader('Vary', 'Origin');
      if (request.headers['access-control-request-private-network'] === 'true') {
        response.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
    }

    if (request.method === 'OPTIONS') {
      if (origin && !corsAllowed) {
        sendJson(response, 403, { error: 'Origin is not allowed to access the local Agent Hub' });
        return;
      }
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const url = new URL(request.url ?? '/', 'http://nexus.local');
      const segments = url.pathname.split('/').filter(Boolean).map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          throw new HttpError(400, 'Invalid URL path encoding');
        }
      });
      const method = request.method ?? 'GET';

      if (segments[0] === 'api' && segments[1] === 'install' && origin && !isLoopbackOrigin(origin)) {
        throw new LocalCapabilityError(403, 'Software installation is only available from the local Nexus frontend');
      }

      if (method === 'GET' && url.pathname === '/nexus-bridge') {
        const targetOrigin=url.searchParams.get('origin')??'';
        if(!targetOrigin||!isAllowedOrigin(targetOrigin,options.allowedOrigins??[])){
          throw new HttpError(403,'Nexus bridge target origin is not allowed');
        }
        sendHtml(response,200,hubRelayHtml(targetOrigin));
        return;
      }

      if (method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, {
          ok: true,
          version: '1.5.0',
          capabilities: [
            'chatgpt-plan-direct',
            'popup-relay',
            'ai-generate',
            'image-generate',
            'mis-engine',
            'mis-align',
            'mis-render-live',
            'mis-render-quality',
            'workspace',
            'web-search',
            'weather',
          ],
        });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/avatar/health') {
        sendJson(response, 200, await avatarServer.health());
        return;
      }

      if (method === 'GET' && url.pathname === '/api/mis/aligner/health') {
        sendJson(response, 200, await misAligner.health());
        return;
      }

      if (method === 'GET' && url.pathname === '/api/mis/health') {
        const [aligner, renderer] = await Promise.all([
          misAligner.health(),
          misRenderer.health(),
        ]);
        sendJson(response, 200, {
          ok: Boolean(renderer.live.ok || renderer.quality.ok),
          experimental: true,
          aligner,
          renderer,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/mis/render') {
        const body = await readJson(request, 48 * 1024 * 1024);
        const mode = body.mode === 'quality' ? 'quality' : 'live';
        const sourceImageBase64 = requiredString(body, 'sourceImageBase64');
        const audioBase64 = requiredString(body, 'audioBase64');
        const rawControls = body.articulationControls;
        let articulationControls: Array<{
          atMs: number;
          jawOpen: number;
          lipWide: number;
          lipRound: number;
          lipProtrusion: number;
          lipPress: number;
        }> | undefined;
        if (rawControls !== undefined) {
          if (!Array.isArray(rawControls) || rawControls.length > 60000) {
            throw new HttpError(400, 'articulationControls must be an array with at most 60000 points');
          }
          articulationControls = rawControls.map((item, index) => {
            if (!isRecord(item)) throw new HttpError(400, `articulationControls[${index}] must be an object`);
            const keys = ['atMs', 'jawOpen', 'lipWide', 'lipRound', 'lipProtrusion', 'lipPress'] as const;
            const values = Object.fromEntries(keys.map((key) => {
              const value = item[key];
              if (typeof value !== 'number' || !Number.isFinite(value)) {
                throw new HttpError(400, `articulationControls[${index}].${key} must be finite`);
              }
              return [key, value];
            })) as Record<(typeof keys)[number], number>;
            if (values.atMs < 0) throw new HttpError(400, `articulationControls[${index}].atMs must be >= 0`);
            for (const key of keys.slice(1)) {
              if (values[key] < 0 || values[key] > 1) {
                throw new HttpError(400, `articulationControls[${index}].${key} must be between 0 and 1`);
              }
            }
            return values;
          });
        }
        const articulationStrength = typeof body.articulationStrength === 'number'
          ? Math.max(0, Math.min(1, body.articulationStrength))
          : undefined;
        const rendered = await misRenderer.render(mode, {
          sourceImageBase64,
          sourceImageMime: typeof body.sourceImageMime === 'string' ? body.sourceImageMime : undefined,
          audioBase64,
          audioMime: typeof body.audioMime === 'string' ? body.audioMime : undefined,
          bodyPrompt: typeof body.bodyPrompt === 'string' ? body.bodyPrompt : undefined,
          negativePrompt: typeof body.negativePrompt === 'string' ? body.negativePrompt : undefined,
          width: typeof body.width === 'number' ? body.width : undefined,
          height: typeof body.height === 'number' ? body.height : undefined,
          fps: typeof body.fps === 'number' ? body.fps : undefined,
          numFrames: typeof body.numFrames === 'number' ? body.numFrames : undefined,
          seed: typeof body.seed === 'number' ? body.seed : undefined,
          articulationControls,
          articulationStrength,
        });
        response.writeHead(200, {
          'Content-Type': rendered.contentType,
          'Content-Length': rendered.data.length,
          'Cache-Control': 'no-store',
          'X-Mis-Experimental': 'true',
          'X-Mis-Renderer': rendered.renderer,
          'X-Mis-Fallback': rendered.fallbackUsed ? 'true' : 'false',
          ...(rendered.engine ? { 'X-Mis-Engine': rendered.engine } : {}),
        });
        response.end(rendered.data);
        return;
      }

      if (method === 'POST' && url.pathname === '/api/mis/align') {
        const body = await readJson(request, 48 * 1024 * 1024);
        const language = requiredString(body, 'language');
        if (!['pl', 'en', 'de'].includes(language)) {
          throw new HttpError(400, 'language must be pl, en or de');
        }
        const transcript = requiredString(body, 'transcript');
        const audioBase64 = requiredString(body, 'audioBase64');
        const phones = await misAligner.align({
          language: language as 'pl' | 'en' | 'de',
          transcript,
          audioBase64,
          audioMime: typeof body.audioMime === 'string' ? body.audioMime : undefined,
        });
        sendJson(response, 200, {
          experimental: true,
          source: 'aligned-audio',
          language,
          phones,
        });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/image/health') {
        sendJson(response, 200, await imageServer.health());
        return;
      }

      if (method === 'POST' && url.pathname === '/api/image/generate') {
        if (!imageServer.configured()) {
          throw new HttpError(503, 'Set NEXUS_IMAGE_SERVER_URL and NEXUS_IMAGE_SERVER_TOKEN');
        }
        const body = await readJson(request, 64 * 1024);
        const rendered = await imageServer.generate({
          prompt: requiredString(body, 'prompt'),
          width: typeof body.width === 'number' ? body.width : undefined,
          height: typeof body.height === 'number' ? body.height : undefined,
          steps: typeof body.steps === 'number' ? body.steps : undefined,
          seed: typeof body.seed === 'number' ? body.seed : undefined,
          guidanceScale: typeof body.guidanceScale === 'number' ? body.guidanceScale : undefined,
        });
        response.writeHead(200, {
          'Content-Type': rendered.contentType,
          'Content-Length': rendered.data.length,
          'Cache-Control': 'no-store',
          ...(rendered.model ? { 'X-Nexus-Model': rendered.model } : {}),
          ...(rendered.seed !== undefined ? { 'X-Nexus-Seed': String(rendered.seed) } : {}),
          ...(rendered.steps !== undefined ? { 'X-Nexus-Steps': String(rendered.steps) } : {}),
        });
        response.end(rendered.data);
        return;
      }

      if (method === 'GET' && url.pathname === '/api/chatgpt/status') {
        sendJson(response, 200, await cloudRouter.chatGptPlanStatus());
        return;
      }

      if (method === 'POST' && url.pathname === '/api/chatgpt/sign-in/start') {
        sendJson(response, 200, await cloudRouter.startChatGptPlanSignIn());
        return;
      }

      if (method === 'POST' && url.pathname === '/api/chatgpt/sign-out') {
        await cloudRouter.signOutChatGptPlan();
        sendJson(response, 200, { ok: true });
        return;
      }

      if (method === 'GET' && url.pathname === '/auth/callback') {
        await cloudRouter.handleChatGptPlanCallback(url);
        sendHtml(response, 200, `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><title>Nexus — ChatGPT połączony</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui;background:#060913;color:#eef7ff;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:36rem;padding:2rem;border:1px solid #26445f;border-radius:20px;background:#0b1220}h1{color:#7ddcff}</style></head>
<body><main><h1>ChatGPT połączony z Nexusem</h1><p>Możesz zamknąć tę kartę i wrócić do Nexusa.</p></main></body></html>`);
        return;
      }

      if (method === 'GET' && url.pathname === '/api/ai/health') {
        sendJson(response, 200, await cloudRouter.health());
        return;
      }

      if (method === 'POST' && url.pathname === '/api/ai/generate') {
        const body = await readJson(request, 2 * 1024 * 1024);
        const prompt = requiredString(body, 'prompt');
        try {
          const result = await cloudRouter.generate(prompt, {
            temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
            maxOutputTokens: typeof body.maxOutputTokens === 'number' ? body.maxOutputTokens : undefined,
          });
          sendJson(response, 200, result);
        } catch (error) {
          throw new HttpError(502, error instanceof Error ? error.message : 'Cloud providers failed');
        }
        return;
      }

      if (method === 'POST' && url.pathname === '/api/avatar/render') {
        if (!avatarServer.configured()) {
          throw new HttpError(503, 'Set NEXUS_AVATAR_SERVER_URL and NEXUS_AVATAR_SERVER_TOKEN');
        }
        const body = await readJson(request, 32 * 1024 * 1024);
        const sourceImageBase64 = requiredString(body, 'sourceImageBase64');
        const audioBase64 = typeof body.audioBase64 === 'string' ? body.audioBase64 : undefined;
        const drivingVideoBase64 = typeof body.drivingVideoBase64 === 'string' ? body.drivingVideoBase64 : undefined;
        if (!audioBase64 && !drivingVideoBase64) {
          throw new HttpError(400, 'audioBase64 or drivingVideoBase64 is required');
        }
        const rendered = await avatarServer.render({
          sourceImageBase64,
          sourceImageMime: typeof body.sourceImageMime === 'string' ? body.sourceImageMime : undefined,
          audioBase64,
          audioMime: typeof body.audioMime === 'string' ? body.audioMime : undefined,
          drivingVideoBase64,
          drivingVideoMime: typeof body.drivingVideoMime === 'string' ? body.drivingVideoMime : undefined,
          subjectMode: body.subjectMode === 'animal' || body.subjectMode === 'human' || body.subjectMode === 'auto'
            ? body.subjectMode
            : undefined,
        });
        response.writeHead(200, {
          'Content-Type': rendered.contentType,
          'Content-Length': rendered.data.length,
          'Cache-Control': 'no-store',
        });
        response.end(rendered.data);
        return;
      }

      if (method === 'GET' && url.pathname === '/api/events') {
        await hub.getAgents();
        if (request.headers.accept?.includes('text/event-stream')) {
          streamEvents(hub, request, response);
          return;
        }
        const requestedLimit = Number(url.searchParams.get('limit') ?? 20);
        const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.floor(requestedLimit))) : 20;
        sendJson(response, 200, { events: hub.getEventLog(limit) });
        return;
      }

      if (method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'search') {
        const query = url.searchParams.get('q') ?? '';
        sendJson(response, 200, await localCapabilities.searchWeb(query));
        return;
      }

      if (method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'weather') {
        const query = url.searchParams.get('q') ?? '';
        sendJson(response, 200, await localCapabilities.getWeather(query));
        return;
      }

      if (method === 'POST' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'workspace' && segments[2] === 'import') {
        const body = await readJson(request, 15 * 1024 * 1024);
        const file = await localCapabilities.importFile(body.filename, body.contentBase64);
        sendJson(response, 201, { file });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/workspace/files') {
        sendJson(response, 200, { files: await localCapabilities.listWorkspaceFiles() });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/workspace/file') {
        const file = await localCapabilities.readWorkspaceFile(url.searchParams.get('path'));
        sendJson(response, 200, { file });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/workspace/file') {
        const body = await readJson(request, 512 * 1024);
        const file = await localCapabilities.writeWorkspaceFile(body.path, body.content, body.confirmed);
        sendJson(response, 200, { file });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/install/catalog') {
        sendJson(response, 200, await localCapabilities.getInstallCatalog());
        return;
      }

      if (method === 'POST' && url.pathname === '/api/install/setup') {
        const body = await readJson(request);
        sendJson(response, 202, await localCapabilities.openInstallerSetup(body.confirmed));
        return;
      }

      if (method === 'POST' && url.pathname === '/api/install') {
        const body = await readJson(request);
        const operation = localCapabilities.startInstall(body.packageId, body.confirmed);
        sendJson(response, 202, { operation });
        return;
      }

      if (method === 'GET' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'install') {
        const operation = localCapabilities.getInstallOperation(segments[2]);
        if (!operation) throw new HttpError(404, 'Installation operation not found');
        sendJson(response, 200, { operation });
        return;
      }

      if (method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'agents') {
        sendJson(response, 200, { agents: await hub.getAgents() });
        return;
      }

      if (method === 'POST' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'agents') {
        const body = await readJson(request);
        const agentId = requiredString(body, 'agentId');
        const kind = requiredString(body, 'kind') as AgentKind;
        if (!agentKinds.includes(kind)) throw new HttpError(400, 'kind is not supported');
        const capabilities = body.capabilities ?? [];
        if (!Array.isArray(capabilities) || !capabilities.every((item) => typeof item === 'string')) {
          throw new HttpError(400, 'capabilities must be an array of strings');
        }
        const agent = await hub.registerAgent({ agentId, kind, capabilities });
        sendJson(response, 201, { agent });
        return;
      }

      if (method === 'POST' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'agents' && segments[3] === 'heartbeat') {
        const agents = await hub.getAgents();
        if (!agents.some((agent) => agent.agentId === segments[2])) throw new HttpError(404, 'Agent not found');
        sendJson(response, 200, { presence: await hub.heartbeat(segments[2]) });
        return;
      }

      if (method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'tasks') {
        await hub.getAgents();
        const status = url.searchParams.get('status');
        if (status && !taskStatuses.includes(status as AgentTaskStatus)) throw new HttpError(400, 'status is not supported');
        sendJson(response, 200, { tasks: hub.listTasks(status as AgentTaskStatus | undefined) });
        return;
      }

      if (method === 'POST' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'tasks') {
        const body = await readJson(request);
        const task = createTask({
          goal: requiredString(body, 'goal'),
          createdBy: requiredString(body, 'createdBy'),
          assignedTo: requiredString(body, 'assignedTo'),
          scope: requiredString(body, 'scope'),
          contextRefs: Array.isArray(body.contextRefs) ? body.contextRefs.filter((item): item is string => typeof item === 'string') : [],
        });
        sendJson(response, 201, { task: await hub.submitTask(task) });
        return;
      }

      if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'tasks') {
        await hub.getAgents();
        const taskId = segments[2];
        if (method === 'GET') {
          const task = hub.getTask(taskId);
          if (!task) throw new HttpError(404, 'Task not found');
          sendJson(response, 200, { task });
          return;
        }
      }

      if (method === 'POST' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'tasks') {
        await hub.getAgents();
        const taskId = segments[2];
        const action = segments[3];
        const body = await readJson(request);
        if (action === 'claim') {
          const task = await hub.claimTask(taskId, requiredString(body, 'agentId'));
          if (!task) throw new HttpError(409, 'Task is missing or leased by another agent');
          sendJson(response, 200, { task });
          return;
        }
        if (action === 'complete') {
          const result = body.result;
          if (!isRecord(result)
            || !['SUCCESS', 'ERROR', 'PARTIAL'].includes(String(result.status))
            || typeof result.summary !== 'string') {
            throw new HttpError(400, 'result must include a valid status and summary');
          }
          const task = await hub.completeTask(taskId, result as unknown as AgentResult);
          if (!task) throw new HttpError(404, 'Task not found');
          sendJson(response, 200, { task });
          return;
        }
        if (action === 'fail') {
          const task = await hub.failTask(taskId, requiredString(body, 'error'));
          if (!task) throw new HttpError(404, 'Task not found');
          sendJson(response, 200, { task });
          return;
        }
        if (action === 'lease') {
          const owner = requiredString(body, 'owner');
          const ttlMs = body.ttlMs ?? 300000;
          if (typeof ttlMs !== 'number' || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000) {
            throw new HttpError(400, 'ttlMs must be an integer between 1000 and 3600000');
          }
          const task = await hub.leaseTask(taskId, owner, ttlMs);
          if (!task) throw new HttpError(409, 'Task is missing or leased by another agent');
          sendJson(response, 200, { task });
          return;
        }
      }

      throw new HttpError(404, 'Route not found');
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const statusCode = error instanceof HttpError || error instanceof LocalCapabilityError ? error.statusCode : 500;
      const message = error instanceof Error ? error.message : 'Internal server error';
      sendJson(response, statusCode, { error: message });
    }
  });
}