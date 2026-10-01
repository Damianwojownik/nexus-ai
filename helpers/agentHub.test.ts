import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentHub } from './agentHub.ts';
import { createAgentHubServer } from './agentHubServer.ts';
import { InMemoryMemoryBackend, MemoryStore } from './memoryStore.ts';
import { createTask } from './agentProtocol.ts';
import { PrimaryAgentProvider } from './primaryAgentProvider.ts';
import { ToolRegistry, registerDefaultTools } from './toolRegistry.ts';
import { ModelRouter } from './modelRouter.ts';

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
