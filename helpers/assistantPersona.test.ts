import test from 'node:test';
import assert from 'node:assert/strict';
import { NexusAgent } from './nexusAgent.ts';
import { ModelRouter } from './modelRouter.ts';
import { MemoryStore, InMemoryMemoryBackend } from './memoryStore.ts';
import { ToolRegistry } from './toolRegistry.ts';
import { LUNA_IDENTITY, LUNA_GREETING, LUNA_EMOTION_CONTEXT, LUNA_IDENTITY_REMINDER } from './assistantPersona.ts';

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
    assert.ok(router.prompt.includes(LUNA_EMOTION_CONTEXT));
    assert.ok(router.prompt.indexOf(LUNA_IDENTITY_REMINDER) > router.prompt.indexOf('Jestem Nexus.'));
    assert.match(router.prompt, /always use feminine grammatical forms/);
    assert.match(result.text, /Luna.*gotowa/);
    assert.match(LUNA_GREETING, /jestem Luna, asystentka Nexus AI/);
  }
});

test('stable persona prefix precedes changing memory/history for local prompt caching', async () => {
  class RecordingRouter extends ModelRouter {
    prompts: string[] = [];
    override async route(prompt: string): Promise<string> {
      this.prompts.push(prompt);
      return 'Jestem Luna.';
    }
  }
  const router = new RecordingRouter();
  const agent = new NexusAgent(router, new MemoryStore(new InMemoryMemoryBackend()), new ToolRegistry());
  await agent.send({ text: 'Cześć' });
  await agent.send({ text: 'Jak masz na imię?', history: [{ role: 'assistant', content: 'Jestem Nexus.' }] });
  const prefixes = router.prompts.map(prompt => prompt.split('Memory context:')[0]);
  assert.equal(prefixes[0], prefixes[1]);
  assert.ok(prefixes[0].includes(LUNA_IDENTITY));
  assert.ok(prefixes[0].includes(LUNA_EMOTION_CONTEXT));
  assert.ok(router.prompts[1].includes('Jestem Nexus.'));
  assert.ok(router.prompts[1].includes('User message: Jak masz na imię?'));
});

test('emotion guidance is contextual and compassionate rather than aggressive', () => {
  assert.match(LUNA_EMOTION_CONTEXT, /meaning of the conversation, not isolated emotion keywords/);
  assert.match(LUNA_EMOTION_CONTEXT, /Do not smile or joke about grief/);
  assert.match(LUNA_EMOTION_CONTEXT, /without mirroring aggression/);
  assert.match(LUNA_EMOTION_CONTEXT, /do not announce emotion labels/);
});
