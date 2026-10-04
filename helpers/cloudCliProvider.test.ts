import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudCliArguments, CloudCliProvider } from './cloudCliProvider.ts';

test('cloud CLIs preserve prompt as one argument and restrict agent tools', () => {
  const prompt = 'hello"; Remove-Item C:\\anything; #';
  const codex = cloudCliArguments('codex', prompt, 'reply.txt');
  assert.equal(codex.at(-1), prompt);
  assert.equal(codex[codex.indexOf('--sandbox') + 1], 'read-only');
  assert(codex.includes('--ephemeral'));
  assert(codex.includes('features.shell_tool=false'));
  assert(codex.includes('features.unified_exec=false'));
  const claude = cloudCliArguments('claude', prompt, 'reply.txt');
  assert.equal(claude[claude.indexOf('--tools') + 1], '');
  assert(claude.includes('--no-session-persistence'));
  assert(claude.includes('--strict-mcp-config'));
  assert(claude.includes('--disable-slash-commands'));
  const copilot = cloudCliArguments('copilot', prompt, 'reply.txt');
  assert.equal(copilot[copilot.indexOf('--available-tools') + 1], '');
  assert(copilot.includes('--no-ask-user'));
  for (const kind of ['copilot', 'codex', 'claude'] as const) {
    assert.equal(new CloudCliProvider(kind).isLocal, false);
  }
});
