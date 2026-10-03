import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCreationCommand } from './creationCommand.ts';

test('recognizes spoken Polish image commands and keeps the prompt in the same request', () => {
  assert.deepEqual(parseCreationCommand('Wygeneruj zdjęcie: niebieski robot'), {
    kind: 'image',
    description: 'niebieski robot',
  });
  assert.deepEqual(parseCreationCommand('Wygeneruj mi cybernetycznego Nexusa w zielonej matrycy'), {
    kind: 'image',
    description: 'cybernetycznego Nexusa w zielonej matrycy',
  });
  assert.deepEqual(parseCreationCommand('Wygeneruj mi to'), { kind: 'image', description: '' });
  assert.equal(parseCreationCommand('Co to jest obraz?'), null);
});
