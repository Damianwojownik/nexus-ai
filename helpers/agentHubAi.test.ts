import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHub } from './agentHub.ts';
import { AIProviderRequestError, AIProviderRouter } from './aiProviderRouter.ts';
import type { AIProvider } from './aiProviderRouter.ts';
import { createAgentHubServer } from './agentHubServer.ts';

test('Agent Hub AI endpoint returns a local response after cloud quota is exhausted', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-ai-router-'));
  const providers: AIProvider[] = [
    {
      id: 'google-gemini',
      name: 'Google Gemini',
      capabilities: ['ai.chat'],
      priority: 100,
      costClass: 'paid',
      isLocal: false,
      async healthCheck() { return { status: 'healthy', model: 'test-cloud-model' }; },
      async generate() { throw new AIProviderRequestError('quota exhausted', 'quota_exceeded'); },
    },
    {
      id: 'ollama-local',
      name: 'Ollama',
      capabilities: ['ai.chat'],
      priority: 10,
      costClass: 'free-local',
      isLocal: true,
      async healthCheck() { return { status: 'healthy', model: 'test-local-model' }; },
      async generate() { return 'Local fallback succeeded.'; },
    },
  ];
  const aiRouter = new AIProviderRouter(providers, () => {});
  const server = createAgentHubServer(
    new AgentHub({ stateFilePath: join(tempDir, 'state.json') }),
    { workspaceDir: join(tempDir, 'workspace'), aiRouter },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const healthResponse = await fetch(`${baseUrl}/api/ai/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json() as { gemini: { status: string }; ollama: { status: string } };
    assert.equal(health.gemini.status, 'healthy');
    assert.equal(health.ollama.status, 'healthy');

    const strictResponse = await fetch(`${baseUrl}/api/ai/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Cloud only.', allowLocalFallback: false }),
    });
    assert.equal(strictResponse.status, 503);

    const generateResponse = await fetch(`${baseUrl}/api/ai/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Reply with a short confirmation.' }),
    });
    assert.equal(generateResponse.status, 200);
    const result = await generateResponse.json() as { text: string; providerId: string };
    assert.deepEqual(result, { text: 'Local fallback succeeded.', providerId: 'ollama-local' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  }
});
