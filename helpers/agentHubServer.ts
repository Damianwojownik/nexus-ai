import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { AgentHub } from './agentHub.ts';
import { createTask } from './agentProtocol.ts';
import type { AgentKind, AgentResult, AgentTaskStatus } from './agentProtocol.ts';
import { LocalCapabilities, LocalCapabilityError } from './localCapabilities.ts';
import { SelfHostedAvatarServerClient } from './selfHostedAvatarServer.ts';
import { NexusCloudRouter } from './cloudProviders.ts';

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
  const localCapabilities = new LocalCapabilities(options.workspaceDir ?? join(process.cwd(), 'workspace'));
  const avatarServer = new SelfHostedAvatarServerClient();
  const cloudRouter = new NexusCloudRouter();

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

      if (method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/avatar/health') {
        sendJson(response, 200, await avatarServer.health());
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