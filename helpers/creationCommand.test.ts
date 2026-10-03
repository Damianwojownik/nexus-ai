import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCreationCommand } from './creationCommand.ts';

test('routes Polish no-code media commands', () => {
  assert.deepEqual(parseCreationCommand('Wygeneruj film: cybernetyczny Nexus'), { kind: 'video', description: 'cybernetyczny Nexus' });
  assert.deepEqual(parseCreationCommand('Zrób mi obraz futurystycznego miasta'), { kind: 'image', description: 'futurystycznego miasta' });
  assert.deepEqual(parseCreationCommand('Wygeneruj lektora: Witaj w Nexusie'), { kind: 'speech', description: 'Witaj w Nexusie' });
  assert.equal(parseCreationCommand('Napraw projekt'), null);
});
