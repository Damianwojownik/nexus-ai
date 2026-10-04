import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { RemoteAvatar } from './remoteAvatar.ts';
import { AgentHub } from './agentHub.ts';
import { createTask } from './agentProtocol.ts';
import type { AgentKind, AgentResult, AgentTaskStatus } from './agentProtocol.ts';
import { LocalCapabilities, LocalCapabilityError } from './localCapabilities.ts';
import { AIProviderRouter, AIProviderUnavailableError } from './aiProviderRouter.ts';
import type { AIRoutingMode } from './aiProviderRouter.ts';
import { GeminiAIProvider } from './geminiAIProvider.ts';
import { CloudCliProvider } from './cloudCliProvider.ts';
import { LocalSpeech, validateSpeechText } from './localSpeech.ts';
import { OllamaHttpProvider } from './ollamaHttpProvider.ts';
import { CapabilityRegistry, GitHubConnector } from './capabilityRegistry.ts';
import type { ToolConnector } from './capabilityRegistry.ts';
import { HeadroomLocalConnector, OmniRouteLocalConnector } from './localTooling.ts';

const taskStatuses: AgentTaskStatus[] = ['TODO', 'WORKING', 'BLOCKED', 'DONE'];
const agentKinds: AgentKind[] = ['orchestrator', 'primary', 'codex', 'ollama', 'reviewer', 'researcher', 'memory', 'tool'];

export interface AgentHubServerOptions {
  allowedOrigins?: string[];
  workspaceDir?: string;
  imageServerUrl?: string;
  imageServerToken?: string;
  aiRouter?: AIProviderRouter;
  capabilityRegistry?: CapabilityRegistry;
  connectors?: ToolConnector[];
  freeOnly?: boolean;
}

interface AvatarAnimationJob {
  videoId: string;
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

function createDefaultCapabilityRegistry(localCapabilities: LocalCapabilities, connectors: ToolConnector[] = []): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register({
    id: 'browser-search',
    name: 'Local web search',
    authType: 'none',
    priority: 100,
    capabilities: [{ id: 'browser.search', name: 'Search the web', readOnly: true }],
    async healthCheck() {
      return { status: 'healthy' };
    },
    async execute(capability, args) {
      if (capability !== 'browser.search') throw new Error(`Unsupported browser capability: ${capability}`);
      if (typeof args.query !== 'string' || !args.query.trim()) throw new HttpError(400, 'query is required');
      return localCapabilities.searchWeb(args.query);
    },
  });
  registry.register(new GitHubConnector());
  registry.register(new OmniRouteLocalConnector());
  registry.register(new HeadroomLocalConnector());
  for (const connector of connectors) registry.register(connector);
  return registry;
}

function parseRoutingMode(value: unknown): AIRoutingMode {
  if (value === undefined) return 'AUTO';
  if (value === 'AUTO' || value === 'LOCAL' || value === 'CLOUD') return value;
  throw new HttpError(400, 'mode must be AUTO, LOCAL, or CLOUD');
}

function requirePrompt(body: Record<string, unknown>): string {
  const prompt = requiredString(body, 'prompt');
  if (prompt.length > 64000) throw new HttpError(413, 'prompt exceeds 64000 characters');
  return prompt;
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
    if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return true;
    return url.protocol === 'https:' && url.hostname.endsWith('.sandbox.floot.app');
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

export function createAgentHubServer(hub: AgentHub, options: AgentHubServerOptions = {}): Server {
  const localSpeech = new LocalSpeech();
  const localCapabilities = new LocalCapabilities(options.workspaceDir ?? join(process.cwd(), 'workspace'));
  const freeOnly = options.freeOnly ?? true;
  const aiRouter = options.aiRouter ?? new AIProviderRouter([
    new CloudCliProvider('codex'), new CloudCliProvider('copilot'), new CloudCliProvider('claude'),
    new GeminiAIProvider(), new OllamaHttpProvider({ cpuOnly: true }),
  ], undefined, { freeOnly });
  const capabilityRegistry = options.capabilityRegistry ?? createDefaultCapabilityRegistry(localCapabilities, options.connectors);
  const fasterLivePortraitDir = resolve(process.env.FASTER_LIVE_PORTRAIT_DIR ?? join(homedir(), 'FasterLivePortrait'));
  const avatarPortraitsDir = join(fasterLivePortraitDir, 'checkpoints', 'nexus_user_portraits');
  const avatarJobs = new Map<string, AvatarAnimationJob>();

  const server = createServer(async (request, response) => {
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
      if (url.pathname.startsWith('/api/speech/') && origin && !isLoopbackOrigin(origin)) {
        throw new HttpError(403, 'Local speech is only available from the local Nexus UI.');
      }
      if (method === 'GET' && url.pathname === '/api/speech/health') {
        sendJson(response, 200, await localSpeech.health());
        return;
      }
      if (method === 'POST' && url.pathname === '/api/speech/synthesize') {
        const body = await readJson(request, 32 * 1024);
        let text: string;
        try { text = validateSpeechText(body.text); }
        catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid speech text.'); }
        if (!(await localSpeech.health()).available) throw new HttpError(503, 'Polish speech voice is not installed.');
        const controller = new AbortController();
        const abort = () => { if (!response.writableEnded) controller.abort(); };
        request.once('aborted', abort);
        response.once('close', abort);
        try {
          const audio = await localSpeech.synthesize(text, controller.signal);
          response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
          response.end(audio);
        } finally {
          request.off('aborted', abort);
          response.off('close', abort);
        }
        return;
      }

      if (segments[0] === 'api' && segments[1] === 'install' && origin && !isLoopbackOrigin(origin)) {
        throw new LocalCapabilityError(403, 'Software installation is only available from the local Nexus frontend');
      }

      if (method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/image/generate') {
        if (origin && !isLoopbackOrigin(origin)) throw new HttpError(403, 'Image generation is only available from the local Nexus frontend');
        const endpoint = options.imageServerUrl ?? process.env.NEXUS_IMAGE_SERVER_URL;
        const token = options.imageServerToken ?? process.env.NEXUS_IMAGE_SERVER_TOKEN;
        if (!endpoint || !token) throw new HttpError(503, 'Nexus Image Engine is not connected. Set NEXUS_IMAGE_SERVER_URL and NEXUS_IMAGE_SERVER_TOKEN in the Agent Hub environment.');
        const body = await readJson(request, 16 * 1024);
        const prompt = requiredString(body, 'prompt');
        if (prompt.length > 4000) throw new HttpError(413, 'Image prompt exceeds 4000 characters');

        let imageEndpoint: URL;
        try {
          imageEndpoint = new URL(endpoint);
        } catch {
          throw new HttpError(503, 'NEXUS_IMAGE_SERVER_URL must be a valid HTTPS URL or loopback HTTP URL');
        }
        const loopback = imageEndpoint.hostname === 'localhost' || imageEndpoint.hostname === '127.0.0.1' || imageEndpoint.hostname === '[::1]';
        if ((imageEndpoint.protocol !== 'https:' && !(imageEndpoint.protocol === 'http:' && loopback))
          || imageEndpoint.username || imageEndpoint.password) {
          throw new HttpError(503, 'NEXUS_IMAGE_SERVER_URL must use HTTPS unless it points to loopback');
        }

        const imageResponse = await fetch(new URL('/v1/generate', imageEndpoint), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
          signal: AbortSignal.timeout(15 * 60 * 1000),
        });
        if (!imageResponse.ok) {
          const upstreamBody = await imageResponse.text();
          let detail = `Nexus Image Engine returned HTTP ${imageResponse.status}`;
          try {
            const parsed: unknown = JSON.parse(upstreamBody);
            if (isRecord(parsed) && typeof parsed.detail === 'string') detail += `: ${parsed.detail.slice(0, 500)}`;
          } catch {
            // Keep the upstream status when the server returned non-JSON diagnostics.
          }
          throw new HttpError(502, detail);
        }
        if (imageResponse.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/png') {
          throw new HttpError(502, 'Nexus Image Engine returned an unsupported image format');
        }
        const imageBytes = Buffer.from(await imageResponse.arrayBuffer());
        if (!imageBytes.length || imageBytes.length > 15 * 1024 * 1024) {
          throw new HttpError(502, 'Nexus Image Engine returned an invalid or oversized image');
        }
        const model = imageResponse.headers.get('x-nexus-model');
        const seed = imageResponse.headers.get('x-nexus-seed');
        response.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': imageBytes.length,
          'Cache-Control': 'no-store',
          ...(model ? { 'X-Nexus-Model': model } : {}),
          ...(seed ? { 'X-Nexus-Seed': seed } : {}),
        });
        response.end(imageBytes);
        return;
      }

      if (method === 'GET' && url.pathname === '/api/ai/health') {
        const providers = await aiRouter.healthCheck();
        sendJson(response, 200, {
          gemini: providers['google-gemini'] ?? { status: 'not_configured', message: 'Google Gemini provider is not registered.' },
          ollama: providers['ollama-local'] ?? { status: 'not_configured', message: 'Ollama provider is not registered.' },
          providers,
          freeOnly,
          ollamaCpuOnly: options.aiRouter === undefined,
          cloud: Object.entries(providers).filter(([id]) => id !== 'ollama-local').some(([, health]) => health.status === 'healthy')
            ? { status: 'healthy' } : { status: 'not_configured', message: 'No cloud CLI/API is ready.' },
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/avatar/portrait') {
        if (origin && !isLoopbackOrigin(origin)) {
          throw new LocalCapabilityError(403, 'Avatar portraits can only be uploaded from the local Nexus frontend');
        }
        const body = await readJson(request, 8 * 1024 * 1024);
        const portraitData = requiredString(body, 'portraitData');
        const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(portraitData);
        if (!match) throw new HttpError(400, 'Portrait must be a PNG, JPEG, or WebP data URL');
        const imageBytes = Buffer.from(match[2], 'base64');
        if (!imageBytes.length || imageBytes.length > 5 * 1024 * 1024) {
          throw new HttpError(413, 'Portrait must be smaller than 5 MB after local resizing');
        }
        const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
        await mkdir(avatarPortraitsDir, { recursive: true });
        const portraitPath = join(avatarPortraitsDir, `${randomUUID()}.${extension}`);
        await writeFile(portraitPath, imageBytes, { flag: 'wx' });
        sendJson(response, 201, { portraitPath, bytes: imageBytes.length });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/avatar/config') {
        sendJson(response, 200, {
          provider: 'nexus-cloud',
          localRenderingEnabled: false,
          configured: !!process.env.NEXUS_AVATAR_SERVER_URL && !!process.env.NEXUS_AVATAR_SERVER_TOKEN,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/avatar/animate') {
        if (origin && !isLoopbackOrigin(origin)) throw new HttpError(403, 'Cloud avatar generation is only available from the local Nexus frontend');
        const body = await readJson(request, 256 * 1024);
        if (body.provider !== 'nexus-cloud' || body.cloudConsent !== true) throw new HttpError(400, 'Local GPU rendering is disabled. Explicit Nexus cloud consent is required.');
        const endpoint = process.env.NEXUS_AVATAR_SERVER_URL;
        const token = process.env.NEXUS_AVATAR_SERVER_TOKEN;
        if (!endpoint || !token) throw new HttpError(503, 'Własny serwer animacji nie jest podłączony. Ustaw NEXUS_AVATAR_SERVER_URL i NEXUS_AVATAR_SERVER_TOKEN. HeyGen nie jest wymagany; lokalny render GPU jest wyłączony.');
        const portraitPath = requiredString(body, 'portraitPath');
        const text = requiredString(body, 'text');
        if (text.length > 5000) throw new HttpError(413, 'Avatar script exceeds 5000 characters');

        const checkpointsDir = resolve(fasterLivePortraitDir, 'checkpoints');
        if (portraitPath) {
          const relativePortraitPath = relative(checkpointsDir, resolve(portraitPath));
          if (relativePortraitPath === '..' || relativePortraitPath.startsWith(`..${sep}`) || isAbsolute(relativePortraitPath)) {
            throw new HttpError(400, 'Portrait path must be inside FasterLivePortrait/checkpoints');
          }
        }

        const extension = extname(portraitPath).toLowerCase();
        if (!['.png', '.jpg', '.jpeg'].includes(extension)) throw new HttpError(400, 'The avatar engine requires PNG or JPEG. Select your portrait again to convert it.');
        const image = await readFile(portraitPath);
        if (!image.length || image.length > 5 * 1024 * 1024) throw new HttpError(413, 'Portrait must be smaller than 5 MB');
        const videoId = await new RemoteAvatar(endpoint, token).generate(image, extension === '.png' ? 'image/png' : 'image/jpeg', text);
        const jobId = randomUUID();
        avatarJobs.set(jobId, { videoId });
        sendJson(response, 202, { jobId, status: 'processing' });
        return;
      }

      if (method === 'GET' && segments[0] === 'api' && segments[1] === 'avatar' && segments[2] === 'result') {
        const job = avatarJobs.get(segments[3] ?? '');
        if (!job) throw new HttpError(404, 'Avatar animation job not found');
        const endpoint = process.env.NEXUS_AVATAR_SERVER_URL;
        const token = process.env.NEXUS_AVATAR_SERVER_TOKEN;
        if (!endpoint || !token) throw new HttpError(503, 'Nexus cloud avatar server is not configured');
        const result = await new RemoteAvatar(endpoint, token).result(job.videoId);
        sendJson(response, 200, { ...result, ...(result.status === 'complete' ? { videoUrl: `/api/avatar/video/${segments[3]}` } : {}) });
        return;
      }

      if (method === 'GET' && segments[0] === 'api' && segments[1] === 'avatar' && segments[2] === 'video') {
        const job = avatarJobs.get(segments[3] ?? '');
        if (!job) throw new HttpError(404, 'Avatar job not found');
        const endpoint = process.env.NEXUS_AVATAR_SERVER_URL;
        const token = process.env.NEXUS_AVATAR_SERVER_TOKEN;
        if (!endpoint || !token) throw new HttpError(503, 'Nexus cloud avatar server is not configured');
        const video = await new RemoteAvatar(endpoint, token).video(job.videoId);
        if (!video.body) throw new Error('Remote video response has no body');
        const reader = video.body.getReader();
        response.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
        try {
          while (!response.destroyed) {
            const chunk = await reader.read();
            if (chunk.done) break;
            await new Promise<void>((resolve, reject) => response.write(chunk.value, error => error ? reject(error) : resolve()));
          }
          response.end();
        } catch (error) {
          console.error('Remote avatar video streaming failed:', error);
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
        return;
      }

      if (method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/ai/generate') {
        const body = await readJson(request, 256 * 1024);
        if (body.allowLocalFallback !== undefined && typeof body.allowLocalFallback !== 'boolean') {
          throw new HttpError(400, 'allowLocalFallback must be a boolean');
        }
        const prompt = requirePrompt(body);
        if (freeOnly && body.provider !== undefined && body.provider !== 'ollama' && body.provider !== 'ollama-local') {
          throw new HttpError(403, 'Only free local Ollama is allowed. Cloud providers are disabled.');
        }
        const temperature = body.temperature;
        const maxOutputTokens = body.maxOutputTokens;
        if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
          throw new HttpError(400, 'temperature must be between 0 and 2');
        }
        if (maxOutputTokens !== undefined && (typeof maxOutputTokens !== 'number' || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32768)) {
          throw new HttpError(400, 'maxOutputTokens must be an integer between 1 and 32768');
        }
        const controller = new AbortController();
        const abortIfDisconnected = () => {
          if (!response.writableEnded) controller.abort(new DOMException('The client disconnected', 'AbortError'));
        };
        request.once('aborted', abortIfDisconnected);
        response.once('close', abortIfDisconnected);
        try {
          const result = await aiRouter.generate(prompt, {
            allowLocalFallback: body.allowLocalFallback !== false,
            mode: parseRoutingMode(body.mode),
            signal: controller.signal,
            ...(typeof temperature === 'number' ? { temperature } : {}),
            ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
          });
          sendJson(response, 200, { text: result.text, providerId: result.providerId });
        } finally {
          request.off('aborted', abortIfDisconnected);
          response.off('close', abortIfDisconnected);
        }
        return;
      }

      if (method === 'POST' && url.pathname === '/api/ai/stream') {
        const body = await readJson(request, 256 * 1024);
        if (body.allowLocalFallback !== undefined && typeof body.allowLocalFallback !== 'boolean') {
          throw new HttpError(400, 'allowLocalFallback must be a boolean');
        }
        const prompt = requirePrompt(body);
        const mode = parseRoutingMode(body.mode);
        const controller = new AbortController();
        const abortIfDisconnected = () => {
          if (!response.writableEnded) controller.abort(new DOMException('The client disconnected', 'AbortError'));
        };
        request.once('aborted', abortIfDisconnected);
        response.once('close', abortIfDisconnected);
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        try {
          const result = await aiRouter.stream(prompt, (chunk) => {
            if (!response.destroyed) response.write(`event: token\ndata: ${JSON.stringify({ text: chunk })}\n\n`);
          }, { mode, signal: controller.signal, allowLocalFallback: body.allowLocalFallback !== false });
          if (!response.destroyed) {
            response.write(`event: complete\ndata: ${JSON.stringify({ providerId: result.providerId })}\n\n`);
            response.end();
          }
        } catch (error) {
          if (!response.destroyed) {
            const message = error instanceof AIProviderUnavailableError
              ? error.message
              : error instanceof Error ? error.message : 'AI streaming failed';
            response.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
            response.end();
          }
        } finally {
          request.off('aborted', abortIfDisconnected);
          response.off('close', abortIfDisconnected);
        }
        return;
      }

      if (method === 'GET' && url.pathname === '/api/capabilities') {
        sendJson(response, 200, { capabilities: await capabilityRegistry.listCapabilities() });
        return;
      }

      if (method === 'POST' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'capabilities') {
        const body = await readJson(request);
        const args = body.args === undefined ? {} : body.args;
        if (!isRecord(args)) throw new HttpError(400, 'args must be a JSON object');
        const result = await capabilityRegistry.execute(segments[2], args);
        sendJson(response, 200, result);
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
      const statusCode = error instanceof HttpError || error instanceof LocalCapabilityError
        ? error.statusCode
        : error instanceof AIProviderUnavailableError ? 503 : 500;
      const message = error instanceof Error ? error.message : 'Internal server error';
      sendJson(response, statusCode, { error: message });
    }
  });
  server.once('close', () => localSpeech.close());
  return server;
}