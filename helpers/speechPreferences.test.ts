import test from 'node:test';
import assert from 'node:assert/strict';
import { createFinalSpeechSubmission, matchingVoices, selectSpeechVoice, speechLanguage, speechReplyContext, speechPreview } from './speechPreferences.ts';

const voices = [
  { voiceURI: 'pl-system', name: 'Paulina', lang: 'pl-PL', localService: true, default: true },
  { voiceURI: 'pl-natural', name: 'Polish Natural Online', lang: 'pl-PL', localService: false, default: false },
  { voiceURI: 'en-natural', name: 'English Natural', lang: 'en-US', localService: false, default: false },
];
test('language and voice match, prefer natural voice, respect explicit selection', () => {
  assert.equal(selectSpeechVoice(voices, 'pl-PL', '')?.voiceURI, 'pl-natural');
  assert.equal(selectSpeechVoice(voices, 'pl-PL', 'pl-system')?.voiceURI, 'pl-system');
  assert.equal(selectSpeechVoice(voices, 'en-GB', 'pl-system')?.voiceURI, 'en-natural');
  assert.equal(selectSpeechVoice(voices, 'de-DE', ''), undefined);
  assert.equal(matchingVoices(voices, 'pl-PL').length, 2);
  assert.equal(speechLanguage('invalid').code, 'pl-PL');
  assert.match(speechReplyContext('de-DE'), /Deutsch.*de-DE/);
  assert.match(speechPreview('de-DE'), /Hallo/);
  const regionalVoices = [...voices, { ...voices[2], voiceURI: 'en-uk', name: 'UK voice', lang: 'en-GB' }];
  assert.equal(selectSpeechVoice(regionalVoices, 'en-GB', '')?.voiceURI, 'en-uk');
});
test('final transcript submits immediately and only once without waiting for onend', () => {
  const submitted: string[] = [];
  const submit = createFinalSpeechSubmission(text => submitted.push(text));
  assert.equal(submit('  '), false);
  assert.equal(submit(' hello '), true);
  assert.deepEqual(submitted, ['hello']);
  assert.equal(submit('hello'), false);
  assert.equal(submit('later onend'), false);
  assert.deepEqual(submitted, ['hello']);
});
