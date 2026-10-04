import test from 'node:test';
import assert from 'node:assert/strict';
import type { AIProvider } from './aiProviderRouter.ts';
import { generatePortraitPromptViaGemini, generateFluxPrompt } from './portraitGenerator.ts';

test('portrait refinement uses the provider string contract and preserves its reply', async () => {
  let received = '';
  const provider: AIProvider = {
    id: 'test', name: 'test', capabilities: ['ai.chat'], priority: 1, costClass: 'included', isLocal: false,
    healthCheck: async () => ({ status: 'healthy' }),
    generate: async prompt => { received = prompt; return 'Detailed Nexus portrait'; },
  };
  assert.equal(await generatePortraitPromptViaGemini(provider), 'Detailed Nexus portrait');
  assert.match(received, /world-class concept artist/);
  assert.match(received, /Return ONLY the prompt/);
  assert.equal(await generatePortraitPromptViaGemini(), generateFluxPrompt());
});
