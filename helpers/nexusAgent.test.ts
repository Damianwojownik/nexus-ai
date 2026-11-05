import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStore, InMemoryMemoryBackend } from './memoryStore.ts';
import { NexusAgent, parseNexusModelAction } from './nexusAgent.ts';
import { ToolRegistry } from './toolRegistry.ts';
import type { ModelRouter } from './modelRouter.ts';

test('parses the documented Nexus tool-call protocol', () => {
  assert.deepEqual(
    parseNexusModelAction('{"type":"tool_call","name":"web_search","arguments":{"query":"Nexus AI"}}'),
    { type: 'tool_call', name: 'web_search', arguments: { query: 'Nexus AI' } },
  );
  assert.deepEqual(
    parseNexusModelAction('```json\n{"type":"final","text":"Gotowe"}\n```'),
    { type: 'final', text: 'Gotowe' },
  );
  assert.equal(parseNexusModelAction('Zwykła odpowiedź bez wywołania narzędzia.'), undefined);
});

test('Nexus executes only explicitly model-callable read tools and uses their result in the final answer', async () => {
  const registry = new ToolRegistry();
  let invoked = 0;
  registry.register({
    name: 'safe_lookup',
    description: 'Read-only test lookup.',
    permissionLevel: 'read',
    modelCallable: true,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    execute: async ({ query }) => {
      invoked += 1;
      return { result: `Verified: ${String(query)}` };
    },
  });
  registry.register({
    name: 'hidden_write',
    description: 'Must never be exposed to the model.',
    permissionLevel: 'write',
    modelCallable: true,
    inputSchema: { type: 'object' },
    execute: async () => ({ ok: true }),
  });

  const replies = [
    '{"type":"tool_call","name":"safe_lookup","arguments":{"query":"current fact"}}',
    '{"type":"final","text":"The verified result is available."}',
  ];
  const prompts: string[] = [];
  const fakeRouter = {
    setPreferredMode: () => undefined,
    route: async (prompt: string) => {
      prompts.push(prompt);
      return replies.shift() ?? '{"type":"final","text":"Fallback"}';
    },
  };
  const agent = new NexusAgent(
    fakeRouter as unknown as ModelRouter,
    new MemoryStore(new InMemoryMemoryBackend()),
    registry,
  );

  const result = await agent.send({ text: 'Find a current fact' });
  assert.equal(invoked, 1);
  assert.equal(result.text, 'The verified result is available.');
  assert.deepEqual(result.reasoning.filter((item) => item.startsWith('Executed safe tools:')), ['Executed safe tools: safe_lookup']);
  assert.match(prompts[1], /Verified: current fact/);
  assert.doesNotMatch(prompts[0], /hidden_write/);
});

test('model-driven execution cannot invoke a registered but non-callable tool', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'private_file_read',
    description: 'Not exposed to the model.',
    permissionLevel: 'read',
    inputSchema: { type: 'object' },
    execute: async () => 'secret',
  });

  assert.deepEqual(registry.listModelCallable(), []);
  await assert.rejects(
    () => registry.execute('private_file_read', {}, { invokedByModel: true }),
    /not permitted for model-driven execution/i,
  );
});
