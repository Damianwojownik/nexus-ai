import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentHub } from './agentHub.ts';
import { MemoryStore } from './memoryStore.ts';
import { createTask } from './agentProtocol.ts';
import type { AgentTaskStatus } from './agentProtocol.ts';

const makeHub = () => new AgentHub({
  agentId: 'nexus',
  kind: 'orchestrator',
  capabilities: ['memory', 'routing', 'delegation'],
});

test('agent hub creates and updates tasks', async () => {
  const hub = makeHub();
  const task = createTask({
    goal: 'Integrate Ollama provider',
    createdBy: 'chatgpt',
    assignedTo: 'codex',
    scope: 'helpers',
    contextRefs: ['helpers/ollamaClient.ts'],
  });

  hub.submitTask(task);
  assert.equal(hub.getTask(task.id)?.status, 'TODO');

  hub.updateTask(task.id, { status: 'WORKING' as AgentTaskStatus });
  assert.equal(hub.getTask(task.id)?.status, 'WORKING');

  hub.completeTask(task.id, { result: 'done', summary: 'Provider wired' });
  const updated = hub.getTask(task.id);
  assert.equal(updated?.status, 'DONE');
  assert.equal(updated?.result?.summary, 'Provider wired');
});

test('memory store supports update and delete', async () => {
  const memory = new MemoryStore();
  const saved = await memory.saveMemory({
    text: 'Preference: local-first AI',
    category: 'preferences',
    tags: ['ai', 'local'],
  });

  const updated = await memory.updateMemory(saved.id, { text: 'Preference: local-first AI and privacy' });
  assert.match(updated.text, /privacy/);

  await memory.deleteMemory(saved.id);
  assert.deepEqual(await memory.searchMemory('local-first AI'), []);
});
