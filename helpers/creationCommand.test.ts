import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCreationCommand } from './creationCommand.ts';
import { startBingGeneration, DEFAULT_EXTENSION_ID } from './bingBrowser.ts';
import type { ExtensionRuntime } from './bingBrowser.ts';

test('routes Polish creation commands without requiring an AI provider', () => {
  assert.deepEqual(parseCreationCommand('Wygeneruj zdjęcie: niebieski robot'), { kind: 'image', description: 'niebieski robot' });
  assert.deepEqual(parseCreationCommand('Wygeneruj mi cybernetycznego Nexusa w zielonej matrycy'), { kind: 'image', description: 'cybernetycznego Nexusa w zielonej matrycy' });
  assert.deepEqual(parseCreationCommand('Wygeneruj mi to'), { kind: 'image', description: '' });
  assert.deepEqual(parseCreationCommand('Stwórz grafikę: kosmos'), { kind: 'image', description: 'kosmos' });
  assert.deepEqual(parseCreationCommand('zrób awatara z tego zdjęcia'), { kind: 'avatar' });
  assert.deepEqual(parseCreationCommand('Animuj awatara: Cześć!'), { kind: 'animation', text: 'Cześć!' });
  assert.equal(parseCreationCommand('Co to jest obraz?'), null);
});

test('Bing executes open, read, type and approved click through extension', async () => {
  const commands: string[] = [];
  let reads = 0;
  const runtime: ExtensionRuntime = {
    sendMessage(_id, payload, callback) {
      const message = payload as { type: string; command?: string; args?: { text?: string } };
      commands.push(message.command ?? message.type);
      if (message.type === 'hello') callback({ ok: true, enabled: true, hostPermission: true });
      else if (message.type === 'connect') callback({ ok: true, token: 'test-session' });
      else if (message.command === 'open') callback({ ok: true, tabId: 42 });
      else if (message.command === 'read') {
        reads++;
        callback({ ok: true, url: 'https://www.bing.com/images/create/ai-image-generator', elements: reads === 1
          ? [{ ref: 'rinput', tag: 'textarea', label: 'Describe the image you want to create' }]
          : [{ ref: 'rcreate', tag: 'button', label: 'Generate' }] });
      } else {
        if (message.command === 'type') assert.equal(message.args?.text, 'Blue robot');
        callback({ ok: true });
      }
    },
  };
  const result = await startBingGeneration(runtime, DEFAULT_EXTENSION_ID, 'Blue robot', () => {}, async () => {});
  assert.equal(result.tabId, 42);
  assert.deepEqual(commands, ['hello', 'connect', 'open', 'read', 'type', 'read', 'click', 'disconnect']);
});

test('Bing fails explicitly without runtime, description or permission', async () => {
  await assert.rejects(startBingGeneration(undefined, DEFAULT_EXTENSION_ID, 'robot', () => {}), /VS Code/);
  await assert.rejects(startBingGeneration(undefined, DEFAULT_EXTENSION_ID, '', () => {}), /1–500/);
  const runtime: ExtensionRuntime = { sendMessage(_id, _message, callback) { callback({ ok: true, enabled: false, hostPermission: false }); } };
  await assert.rejects(startBingGeneration(runtime, DEFAULT_EXTENSION_ID, 'robot', () => {}), /popupie/);
});

test('Bing does not bypass consent denial and disconnects session', async () => {
  const commands: string[] = [];
  const runtime: ExtensionRuntime = { sendMessage(_id, payload, callback) {
    const message = payload as { type: string; command?: string };
    commands.push(message.command ?? message.type);
    if (message.type === 'hello') callback({ ok: true, enabled: true, hostPermission: true });
    else if (message.type === 'connect') callback({ ok: true, token: 'session' });
    else if (message.command === 'open') callback({ ok: false, code: 'CONSENT_DENIED' });
    else callback({ ok: true });
  } };
  await assert.rejects(startBingGeneration(runtime, DEFAULT_EXTENSION_ID, 'robot', () => {}), /CONSENT_DENIED/);
  assert.deepEqual(commands, ['hello', 'connect', 'open', 'disconnect']);
});
