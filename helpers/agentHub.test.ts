import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentHub } from './agentHub.ts';
import { InMemoryMemoryBackend, MemoryStore } from './memoryStore.ts';
import { createTask } from './agentProtocol.ts';
import { PrimaryAgentProvider } from './primaryAgentProvider.ts';
import { ToolRegistry, registerDefaultTools } from './toolRegistry.ts';
import { ModelRouter } from './modelRouter.ts';

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
