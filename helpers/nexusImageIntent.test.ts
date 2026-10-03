import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFallbackImagePrompt, imageDimensionsForText, isImageGenerationIntent } from './nexusImageIntent.ts';

test('detects Polish and English image generation requests', () => {
  assert.equal(isImageGenerationIntent('Wygeneruj obraz kobiety siedzącej na fotelu'), true);
  assert.equal(isImageGenerationIntent('Create a portrait image of a robot'), true);
  assert.equal(isImageGenerationIntent('Opisz kobietę siedzącą na fotelu'), false);
});

test('selects image dimensions from natural-language orientation', () => {
  assert.deepEqual(imageDimensionsForText('zrób pionowy obraz pełnej postaci'), { width: 768, height: 1024, orientation: 'portrait' });
  assert.deepEqual(imageDimensionsForText('generate a wide landscape image'), { width: 1024, height: 768, orientation: 'landscape' });
  assert.deepEqual(imageDimensionsForText('wygeneruj obraz kota'), { width: 1024, height: 1024, orientation: 'square' });
});

test('builds a quality-oriented fallback prompt without changing the requested subject', () => {
  const prompt = buildFallbackImagePrompt('Wygeneruj obraz kobiety siedzącej na fotelu');
  assert.match(prompt, /kobiety siedzącej na fotelu/i);
  assert.match(prompt, /Photorealistic/);
  assert.match(prompt, /no watermark/);
});
