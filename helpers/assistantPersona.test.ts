import test from 'node:test';
import assert from 'node:assert/strict';
import { NexusAgent } from './nexusAgent.ts';
import { ModelRouter } from './modelRouter.ts';
import { MemoryStore, InMemoryMemoryBackend } from './memoryStore.ts';
import { ToolRegistry } from './toolRegistry.ts';
import { LUNA_IDENTITY, LUNA_GREETING } from './assistantPersona.ts';

test('default and company conversations send Luna feminine identity even with old history', async () => {
  class RecordingRouter extends ModelRouter {
    prompt = '';
    override async route(prompt: string): Promise<string> {
      this.prompt = prompt;
      return 'Jestem Luna, asystentka Nexus AI. Jestem gotowa.';
    }
  }
  for (const options of [{}, { systemPrompt: 'You are an independent business assistant.' }]) {
    const router = new RecordingRouter();
    const agent = new NexusAgent(router, new MemoryStore(new InMemoryMemoryBackend()), new ToolRegistry(), options);
    const result = await agent.send({
      text: 'Jak masz na imie?',
      history: [{ role: 'assistant', content: 'Jestem Nexus.' }],
    });
    assert.ok(router.prompt.includes(LUNA_IDENTITY));
    assert.ok(router.prompt.indexOf(LUNA_IDENTITY) > router.prompt.indexOf('Jestem Nexus.'));
    assert.match(router.prompt, /always use feminine grammatical forms/);
    assert.match(result.text, /Luna.*gotowa/);
    assert.match(LUNA_GREETING, /jestem Luna, asystentka Nexus AI/);
  }
});
