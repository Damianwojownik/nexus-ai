import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCreationCommand } from './creationCommand.ts';
import { advanceCreation, creationQuestion, websiteDocument } from './creationFlow.ts';

test('spoken creation intents work without special prefixes or a model call', () => {
  assert.deepEqual(parseCreationCommand('chcę zrobić stronę'), { kind: 'website', description: '' });
  assert.deepEqual(parseCreationCommand('chce grafike'), { kind: 'image', description: '' });
  assert.deepEqual(parseCreationCommand('chcę avatar ze zdjęcia'), { kind: 'avatar' });
  assert.deepEqual(parseCreationCommand('wygeneruj awatara ze zdjęcia'), { kind: 'avatar' });
  assert.equal(parseCreationCommand('Co powinno być na stronie?'), null);
});

test('website asks only relevant questions and accepts list or free-text answers', () => {
  const first = { step: 'website-type' as const, description: '' };
  assert.equal(creationQuestion(first).choices.length, 4);
  assert.deepEqual(advanceCreation(first, 'Strona firmowa', false), { step: 'website-brief', websiteType: 'Strona firmowa' });
  assert.deepEqual(advanceCreation({ step: 'website-brief', websiteType: 'Strona firmowa' }, 'Firma Alfa, niebieska', false),
    { kind: 'website', description: 'Strona firmowa. Firma Alfa, niebieska' });
  assert.deepEqual(advanceCreation({ ...first, description: 'dla kwiaciarni' }, 'Portfolio', false),
    { kind: 'website', description: 'Portfolio. dla kwiaciarni' });
});

test('missing image description/photo requests input instead of claiming generation', () => {
  assert.deepEqual(advanceCreation({ step: 'image-description' }, 'Niebieski robot', false), { kind: 'image', description: 'Niebieski robot' });
  assert.deepEqual(advanceCreation({ step: 'avatar-photo' }, 'ustaw', false), { step: 'avatar-photo' });
  assert.deepEqual(advanceCreation({ step: 'avatar-photo' }, 'ustaw', true), { kind: 'avatar' });
});

test('website preview accepts complete HTML only and blocks external resources/scripts/forms', () => {
  const html = websiteDocument('```html\n<!DOCTYPE html><html><head><title>Alfa</title></head><body>Alfa</body></html>\n```');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.throws(() => websiteDocument('Strona gotowa!'));
  assert.throws(() => websiteDocument('<html><body>Urwane'));
  assert.throws(() => websiteDocument('<html><body><script>alert(1)</script></body></html>'));
});
