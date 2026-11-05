import assert from 'node:assert/strict';
import test from 'node:test';
import { LUNA_VOICE, validateLunaSpeech } from './nexusLunaTts.ts';

test('Nexus Luna uses independent Polish neural voice', () => {
  assert.equal(LUNA_VOICE, 'pl-PL-ZofiaNeural');
});

test('neural speech normalizes text and refuses unsafe input sizes', () => {
  assert.equal(validateLunaSpeech('  Cześć   świecie! '), 'Cześć świecie!');
  assert.equal(validateLunaSpeech('Zobacz https://example.com ✦ ofertę.'), 'Zobacz ofertę.');
  assert.throws(() => validateLunaSpeech(''), /600 znaków/i);
  assert.throws(() => validateLunaSpeech('x'.repeat(601)), /600 znaków/i);
  assert.throws(() => validateLunaSpeech({ text: 'hej' }), /ciągiem znaków/i);
});
