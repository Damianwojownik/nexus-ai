import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentHub } from './agentHub.ts';
import { AgentHubClient } from './agentHubClient.ts';
import { createAgentHubServer } from './agentHubServer.ts';
import { buildNexusPlan, parseProjectChange } from './nexusOrchestrator.ts';
import { InMemoryMemoryBackend, MemoryStore } from './memoryStore.ts';
import { createTask } from './agentProtocol.ts';
import { PrimaryAgentProvider } from './primaryAgentProvider.ts';
import { ToolRegistry, registerDefaultTools } from './toolRegistry.ts';
import { ModelRouter } from './modelRouter.ts';
import { OllamaClient } from './ollamaClient.ts';
import { OllamaProvider } from './modelRouter.ts';
import { NexusAgent } from './nexusAgent.ts';
import { NexusOrchestrator } from './nexusOrchestrator.ts';
import { LocalCapabilitiesClient } from './localCapabilitiesClient.ts';
import { FileSystemMemoryBackend } from './memoryStore.ts';
import { parseConnectorManifests } from './connectorRegistry.ts';

test('Nexus planner makes one conversational plan and only searches the web on web intent', () => {
  const webPlan = buildNexusPlan('Szukaj w internecie aktualnych informacji o Node.js', [
    { name: 'readme.txt', mimeType: 'text/plain' },
  ]);
  assert.deepEqual(webPlan.map((step) => step.id), ['understand', 'plan', 'search', 'attachments', 'execute', 'verify']);

  const projectPlan = buildNexusPlan('Sprawdź mój projekt, znajdź błędy i je napraw.');
  assert.deepEqual(projectPlan.map((step) => step.id), ['understand', 'plan', 'inspect', 'modify', 'execute', 'verify']);

  const weatherPlan = buildNexusPlan('Jaka jest pogoda w Kolonii dzisiaj?');
  assert.deepEqual(weatherPlan.map((step) => step.id), ['understand', 'plan', 'weather', 'execute', 'verify']);

  const proposal = parseProjectChange('```json\n{"summary":"Popraw funkcję","changes":[{"path":"math.py","oldText":"return a - b","newText":"return a + b"}]}\n```', new Set(['math.py']));
  assert.equal(proposal.change.path, 'math.py');
  assert.throws(() => parseProjectChange('{"summary":"x","changes":[{"path":"outside.py","oldText":"x","newText":"y"}]}', new Set(['math.py'])));
});

test('agent hub client uses the real API and reconnects SSE after disconnect', { timeout: 20000 }, async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-hub-client-'));
  const hub = new AgentHub({ stateFilePath: join(tempDir, 'hub-state.json') });
  const server = createAgentHubServer(hub);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = new AgentHubClient(`http://127.0.0.1:${address.port}`, 100, 500);
  let connectionCount = 0;
  let resolveFirstConnection!: () => void;
  let resolveReconnection!: () => void;
  let resolveTaskEvent!: () => void;
  const firstConnection = new Promise<void>((resolve) => { resolveFirstConnection = resolve; });
  const reconnection = new Promise<void>((resolve) => { resolveReconnection = resolve; });
  const taskEvent = new Promise<void>((resolve) => { resolveTaskEvent = resolve; });
  const withTimeout = (promise: Promise<void>, message: string) => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), 5000);
    promise.then(() => {
      clearTimeout(timeout);
      resolve();
    }, (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  const disconnectEvents = client.subscribeEvents((event) => {
    if (event.message === 'Task submitted: Verify client SSE recovery') resolveTaskEvent();
  }, (status) => {
    if (status === 'CONNECTED') {
      connectionCount += 1;
      if (connectionCount === 1) resolveFirstConnection();
      if (connectionCount === 2) resolveReconnection();
    }
  });

  try {
    await withTimeout(firstConnection, 'Timed out waiting for initial SSE connection');
    await client.registerAgent({ agentId: 'nexus-ui', kind: 'orchestrator', capabilities: ['tasks'] });
    assert.equal((await client.heartbeat('nexus-ui')).connected, true);
    assert.ok((await client.getAgents()).some((agent) => agent.agentId === 'nexus-ui'));

    const submitted = await client.submitTask({
      goal: 'Verify client SSE recovery',
      createdBy: 'nexus-ui',
      assignedTo: 'nexus-ui',
      scope: 'helpers',
    });
    assert.equal((await client.getTasks('TODO')).some((task) => task.id === submitted.id), true);
    assert.equal((await client.claimTask(submitted.id, 'nexus-ui')).status, 'WORKING');
    assert.equal((await client.leaseTask(submitted.id, 'nexus-ui', 60000)).lease?.owner, 'nexus-ui');

    server.closeAllConnections();
    await withTimeout(reconnection, 'Timed out waiting for SSE reconnection');
    await client.submitTask({
      goal: 'Verify client SSE recovery',
      createdBy: 'nexus-ui',
      assignedTo: 'nexus-ui',
      scope: 'helpers',
    });
    await withTimeout(taskEvent, 'Timed out waiting for an event after reconnection');
    assert.ok(connectionCount >= 2);
  } finally {
    disconnectEvents();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Nexus orchestrates a real local model turn, completes the Hub task and persists memory', { timeout: 90000 }, async (context) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-orchestrator-e2e-'));
  const ollama = new OllamaClient('http://127.0.0.1:11435', 'qwen2.5:1.5b', 60000);
  const modelHealth = await ollama.checkHealth('qwen2.5:1.5b');
  if (modelHealth.status !== 'CONNECTED') {
    rmSync(tempDir, { recursive: true, force: true });
    context.skip(`Real Ollama qwen2.5:1.5b unavailable: ${modelHealth.status}`);
    return;
  }

  const hub = new AgentHub({ stateFilePath: join(tempDir, 'hub-state.json') });
  const server = createAgentHubServer(hub, { workspaceDir: join(tempDir, 'workspace') });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const hubClient = new AgentHubClient(`http://127.0.0.1:${address.port}`);
  const memoryFile = join(tempDir, 'nexus-memory.json');
  const memory = new MemoryStore(new FileSystemMemoryBackend(memoryFile));
  const router = new ModelRouter('AUTO', [new OllamaProvider(ollama)]);
  const agent = new NexusAgent(router, memory, new ToolRegistry());
  const orchestrator = new NexusOrchestrator(agent, hubClient, memory, new LocalCapabilitiesClient(`http://127.0.0.1:${address.port}`));
  const progressStates: string[] = [];

  try {
    const result = await orchestrator.start({
      text: 'Reply in Polish with a short confirmation that the real Nexus local workflow ran.',
    }, (progress) => progressStates.push(progress.state));
    assert.equal(result.status, 'DONE');
    assert.ok(result.text.trim().length > 0);
    assert.ok(progressStates.includes('THINKING'));
    assert.ok(progressStates.includes('WORKING'));
    assert.ok(progressStates.includes('TESTING'));
    assert.equal(progressStates.at(-1), 'DONE');

    const tasks = await hubClient.getTasks('DONE');
    assert.ok(tasks.some((task) => task.id === result.taskId && task.result?.status === 'SUCCESS'));

    const restoredMemory = new MemoryStore(new FileSystemMemoryBackend(memoryFile));
    const memories = await restoredMemory.searchMemory('Reply in Polish with a short confirmation', 5);
    assert.ok(memories.some((item) => item.text.includes(result.text.slice(0, 60))));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Nexus applies one verified repair through the approval-checked workspace writer', { timeout: 30000 }, async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-repair-e2e-'));
  const workspaceDir = join(tempDir, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, 'math.py'), 'def add(a, b):\n    return a - b\n');
  const hub = new AgentHub({ stateFilePath: join(tempDir, 'hub-state.json') });
  const server = createAgentHubServer(hub, { workspaceDir });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const hubClient = new AgentHubClient(baseUrl);
  const memory = new MemoryStore(new FileSystemMemoryBackend(join(tempDir, 'nexus-memory.json')));
  const repairAgent = {
    async send() {
      return {
        text: JSON.stringify({
          summary: 'Poprawiłem funkcję add, aby dodawała argumenty.',
          changes: [{ path: 'math.py', oldText: 'return a - b', newText: 'return a + b' }],
        }),
        mode: 'LOCAL' as const,
        reasoning: [],
      };
    },
  };
  const orchestrator = new NexusOrchestrator(repairAgent as unknown as NexusAgent, hubClient, memory, new LocalCapabilitiesClient(baseUrl));

  try {
    const result = await orchestrator.start({ text: 'Fix the bug in my project: the add function must add a and b, not subtract them.' });
    assert.equal(result.status, 'DONE');
    assert.equal(result.plan.find((step) => step.id === 'modify')?.state, 'DONE');
    assert.match(readFileSync(join(workspaceDir, 'math.py'), 'utf8'), /return\s+a\s*\+\s*b/);
    assert.match(result.text, /Poprawiłem funkcję add/);

    const tasks = await hubClient.getTasks('DONE');
    assert.ok(tasks.some((task) => task.id === result.taskId && task.result?.status === 'SUCCESS'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('workspace import is path-safe and installs require explicit confirmation', { timeout: 15000 }, async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-local-capabilities-'));
  const hub = new AgentHub({ stateFilePath: join(tempDir, 'hub-state.json') });
  const server = createAgentHubServer(hub, { workspaceDir: join(tempDir, 'workspace') });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const catalogResponse = await fetch(`${baseUrl}/api/install/catalog`);
    const catalog = await catalogResponse.json() as { requiresConfirmation: boolean; apps: Array<{ id: string }> };
    assert.equal(catalog.requiresConfirmation, true);
    assert.ok(catalog.apps.some((app) => app.id === 'Microsoft.VisualStudioCode'));

    const deniedInstall = await fetch(`${baseUrl}/api/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageId: 'Microsoft.VisualStudioCode', confirmed: false }),
    });
    assert.equal(deniedInstall.status, 403);

    const deniedInstallerSetup = await fetch(`${baseUrl}/api/install/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: false }),
    });
    assert.equal(deniedInstallerSetup.status, 403);

    const remoteInstallerSetup = await fetch(`${baseUrl}/api/install/setup`, {
      method: 'POST',
      headers: {
        Origin: 'https://nexus.sandbox.floot.app',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ confirmed: true }),
    });
    assert.equal(remoteInstallerSetup.status, 403);

    const remoteInstall = await fetch(`${baseUrl}/api/install`, {
      method: 'POST',
      headers: {
        Origin: 'https://nexus.sandbox.floot.app',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ packageId: 'Microsoft.VisualStudioCode', confirmed: true }),
    });
    assert.equal(remoteInstall.status, 403);

    const content = 'Imported through the real Nexus workspace endpoint.';
    const imported = await fetch(`${baseUrl}/api/workspace/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'capability-smoke.txt', contentBase64: Buffer.from(content).toString('base64') }),
    });
    assert.equal(imported.status, 201);
    const details = await imported.json() as { file: { filename: string; bytes: number } };
    assert.equal(details.file.filename, 'capability-smoke.txt');
    assert.equal(readFileSync(join(tempDir, 'workspace', details.file.filename), 'utf8'), content);

    const fileListing = await fetch(`${baseUrl}/api/workspace/files`);
    assert.ok((await fileListing.json() as { files: string[] }).files.includes('capability-smoke.txt'));
    const fileRead = await fetch(`${baseUrl}/api/workspace/file?path=capability-smoke.txt`);
    assert.equal((await fileRead.json() as { file: { content: string } }).file.content, content);

    const deniedWrite = await fetch(`${baseUrl}/api/workspace/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'capability-smoke.txt', content: 'changed', confirmed: false }),
    });
    assert.equal(deniedWrite.status, 403);
    const approvedContent = 'Repaired through the approved workspace writer.';
    const approvedWrite = await fetch(`${baseUrl}/api/workspace/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'capability-smoke.txt', content: approvedContent, confirmed: true }),
    });
    assert.equal(approvedWrite.status, 200);
    assert.equal(readFileSync(join(tempDir, 'workspace', 'capability-smoke.txt'), 'utf8'), approvedContent);

    const outsideWorkspace = await fetch(`${baseUrl}/api/workspace/file?path=../outside.txt`);
    assert.equal(outsideWorkspace.status, 400);

    const traversal = await fetch(`${baseUrl}/api/workspace/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: '../outside.txt', contentBase64: Buffer.from(content).toString('base64') }),
    });
    assert.equal(traversal.status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('agent hub API exposes presence and streams task events', { timeout: 15000 }, async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-hub-api-'));
  const hub = new AgentHub({ stateFilePath: join(tempDir, 'hub-state.json') });
  const server = createAgentHubServer(hub);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const streamController = new AbortController();

  try {
    const preflight = await fetch(`${baseUrl}/api/tasks`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://nexus.sandbox.floot.app',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://nexus.sandbox.floot.app');
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');

    const registration = await fetch(`${baseUrl}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'codex', kind: 'codex', capabilities: ['code'] }),
    });
    assert.equal(registration.status, 201);

    const heartbeat = await fetch(`${baseUrl}/api/agents/codex/heartbeat`, { method: 'POST' });
    assert.equal(heartbeat.status, 200);
    assert.equal((await heartbeat.json()).presence.connected, true);

    const eventStream = await fetch(`${baseUrl}/api/events`, {
      headers: { Accept: 'text/event-stream' },
      signal: streamController.signal,
    });
    assert.equal(eventStream.status, 200);
    assert.match(eventStream.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = eventStream.body!.getReader();

    const submission = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: 'Verify live task events',
        createdBy: 'nexus',
        assignedTo: 'codex',
        scope: 'helpers',
      }),
    });
    assert.equal(submission.status, 201);
    const submittedTask = (await submission.json() as { task: { id: string } }).task;

    let eventText = '';
    const decoder = new TextDecoder();
    while (!eventText.includes('Task submitted: Verify live task events')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      eventText += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(eventText, /Task submitted: Verify live task events/);

    const eventHistoryResponse = await fetch(`${baseUrl}/api/events?limit=10`);
    const eventHistory = await eventHistoryResponse.json() as { events: Array<{ message: string }> };
    assert.ok(eventHistory.events.some((event) => event.message === 'Task submitted: Verify live task events'));

    const completion = await fetch(`${baseUrl}/api/tasks/${submittedTask.id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: { status: 'SUCCESS', summary: 'Verified in API integration test' } }),
    });
    assert.equal(completion.status, 200);
    assert.equal((await completion.json() as { task: { status: string } }).task.status, 'DONE');
    streamController.abort();
  } finally {
    streamController.abort();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('agent hub registers, leases, and completes tasks safely', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-hub-'));
  const hub = new AgentHub({ stateFilePath: join(tempDir, 'hub-state.json') });

  await hub.registerAgent({ agentId: 'nexus', kind: 'orchestrator', capabilities: ['memory', 'routing'] });
  await hub.registerAgent({ agentId: 'codex', kind: 'codex', capabilities: ['code', 'refactor'] });

  const task = createTask({
    goal: 'Integrate Ollama provider',
    createdBy: 'chatgpt',
    assignedTo: 'nexus',
    scope: 'helpers',
    contextRefs: ['helpers/ollamaClient.ts'],
  });

  await hub.submitTask(task);
  const claimed = await hub.claimTask(task.id, 'codex');
  assert.equal(claimed?.status, 'WORKING');
  assert.equal(claimed?.lease?.owner, 'codex');

  const blocked = await hub.claimTask(task.id, 'nexus');
  assert.equal(blocked, undefined);

  const completed = await hub.completeTask(task.id, { status: 'SUCCESS', summary: 'Provider wired' });
  assert.equal(completed?.status, 'DONE');
  assert.equal(completed?.result?.summary, 'Provider wired');

  rmSync(tempDir, { recursive: true, force: true });
});

test('agent presence expires after missed heartbeats and recovers on heartbeat', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-hub-presence-'));
  const hub = new AgentHub({ stateFilePath: join(tempDir, 'hub-state.json'), presenceTimeoutMs: 10 });
  await hub.registerAgent({ agentId: 'worker', kind: 'codex', capabilities: ['code'] });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await hub.getAgents())[0].presence, 'offline');
  assert.equal((await hub.heartbeat('worker')).connected, true);
  assert.equal((await hub.getAgents())[0].presence, 'online');

  rmSync(tempDir, { recursive: true, force: true });
});

test('memory store persists and deduplicates durable entries', async () => {
  const memory = new MemoryStore(new InMemoryMemoryBackend());
  const first = await memory.saveMemory({
    kind: 'durable',
    text: 'Preference: local-first AI',
    category: 'preferences',
    tags: ['ai', 'local'],
    owner: 'nexus',
    scope: 'preferences',
    source: 'user-profile',
    relevance: 0.9,
    sensitive: false,
  });

  const duplicate = await memory.saveMemory({
    kind: 'durable',
    text: 'Preference: local-first AI',
    category: 'preferences',
    tags: ['ai', 'local'],
    owner: 'nexus',
    scope: 'preferences',
    source: 'user-profile',
    relevance: 0.9,
    sensitive: false,
  });

  assert.equal(first.id, duplicate.id);
  const updated = await memory.updateMemory(first.id, { text: 'Preference: local-first AI and privacy' });
  assert.match(updated.text, /privacy/);

  await memory.deleteMemory(first.id);
  assert.deepEqual(await memory.searchMemory('local-first AI'), []);
});

test('primary provider exposes a truthful disconnected state', async () => {
  const notConfigured = new PrimaryAgentProvider({});
  const providerHealth = await notConfigured.health();
  assert.equal(providerHealth.status, 'NOT_CONFIGURED');

  const configured = new PrimaryAgentProvider({ apiKey: 'secret', name: 'chatgpt-primary' });
  const health = await configured.health();
  assert.equal(health.status, 'NOT_CONFIGURED');
});

test('model router falls back to free local Ollama when primary is unavailable or out of tokens', async () => {
  const localProvider = {
    name: 'Ollama',
    mode: 'LOCAL' as const,
    role: 'SUBAGENT' as const,
    async generate(prompt: string) {
      return `local:${prompt}`;
    },
    async checkHealth() {
      return { status: 'CONNECTED' as const, model: 'llama3.2' };
    },
    async listModels() {
      return [{ name: 'llama3.2' }];
    },
  };
  const exhaustedPrimary = {
    name: 'chatgpt-primary',
    mode: 'CLOUD' as const,
    role: 'PRIMARY_ORCHESTRATOR' as const,
    async generate() {
      throw new Error('insufficient_quota: token limit reached');
    },
    async checkHealth() {
      return { status: 'CONNECTED' as const };
    },
    async listModels() {
      return [];
    },
  };

  const withoutPrimary = new ModelRouter('AUTO', [localProvider]);
  assert.match(await withoutPrimary.route('hello'), /^local:/);

  const withExhaustedPrimary = new ModelRouter('AUTO', [localProvider], exhaustedPrimary);
  assert.match(await withExhaustedPrimary.route('hello'), /^local:/);
});

test('tool registry enforces safe execution boundaries', async () => {
  const registry = new ToolRegistry();
  registerDefaultTools(registry);

  const contents = await registry.execute('read_file', { path: './helpers/agentProtocol.ts' });
  assert.match(contents, /export type AgentTaskStatus/);

  await assert.rejects(
    () => registry.execute('git_commit', { cwd: process.cwd(), message: 'demo commit' }, { allowDestructive: false }),
    /requires explicit approval/i,
  );
});


test('connector manifests keep credentials indirect and reject unsafe remote HTTP', () => {
  const parsed = parseConnectorManifests(JSON.stringify([
    {
      id: 'canva-like',
      name: 'Canva-like service',
      transport: 'mcp-http',
      url: 'https://example.test/mcp',
      tokenEnv: 'NEXUS_CANVA_LIKE_TOKEN',
    },
    {
      id: 'local-tool',
      name: 'Local MCP',
      transport: 'mcp-http',
      url: 'http://127.0.0.1:9000/mcp',
    },
  ]));

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].tokenEnv, 'NEXUS_CANVA_LIKE_TOKEN');
  assert.equal((parsed[0] as any).token, undefined);
  assert.throws(
    () => parseConnectorManifests(JSON.stringify([
      { id: 'unsafe', name: 'Unsafe', transport: 'mcp-http', url: 'http://example.test/mcp' },
    ])),
    /HTTPS/i,
  );
  assert.throws(
    () => parseConnectorManifests(JSON.stringify([
      { id: 'dup', name: 'A', transport: 'mcp-http', url: 'https://a.example/mcp' },
      { id: 'dup', name: 'B', transport: 'mcp-http', url: 'https://b.example/mcp' },
    ])),
    /Duplicate connector id/i,
  );
});
