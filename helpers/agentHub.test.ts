import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentHub } from './agentHub.ts';
import { AgentHubClient } from './agentHubClient.ts';
import { createAgentHubServer } from './agentHubServer.ts';
import { InMemoryMemoryBackend, MemoryStore } from './memoryStore.ts';
import { createTask } from './agentProtocol.ts';
import { PrimaryAgentProvider } from './primaryAgentProvider.ts';
import { ToolRegistry, registerDefaultTools } from './toolRegistry.ts';
import { ModelRouter } from './modelRouter.ts';

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

test('model router falls back to the local provider when primary is unavailable', async () => {
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

  const router = new ModelRouter('AUTO', [localProvider]);
  const text = await router.route('hello');
  assert.match(text, /^local:/);
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
