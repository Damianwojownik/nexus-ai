import test from 'node:test';
import assert from 'node:assert/strict';
import {
  needsProjectClarification,
  parseBlueprint,
  parseGeneratedProject,
  safeProjectName,
} from './projectBuilder.ts';
import { isProjectCreationIntent } from './projectIntent.ts';

test('detects a new app request', () => {
  assert.equal(isProjectCreationIntent('Chcę aplikację do planowania treningów'), true);
  assert.equal(isProjectCreationIntent('Jaka jest pogoda?'), false);
});

test('asks for details when the request is only generic', () => {
  assert.equal(needsProjectClarification('Zrób mi aplikację'), true);
  assert.equal(needsProjectClarification('Zrób aplikację do zadań z logowaniem i widokiem mobilnym'), false);
});

test('parses and sanitizes a project blueprint', () => {
  const blueprint = parseBlueprint('{"name":"Mój Feed!","summary":"Feed społecznościowy","stack":"Vite + React","features":["posty","komentarze"]}');
  assert.equal(blueprint.name, 'moj-feed');
  assert.deepEqual(blueprint.features, ['posty','komentarze']);
});

test('rejects generated files that escape the project folder', () => {
  assert.throws(() => parseGeneratedProject('{"name":"x","summary":"x","files":[{"path":"../outside.ts","content":"x"}]}'));
});

test('normalizes a safe project name', () => {
  assert.equal(safeProjectName('  Nexus Feed 2026! '), 'nexus-feed-2026');
});
