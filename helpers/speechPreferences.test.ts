import test from 'node:test';
import assert from 'node:assert/strict';
import { createFinalSpeechSubmission, matchingVoices, selectSpeechVoice, speechLanguage, speechReplyContext, speechPreview, SPEECH_LANGUAGES, prepareSpeechText } from './speechPreferences.ts';

test('voice previews introduce Luna and Polish uses feminine self-reference', () => {
  for (const language of SPEECH_LANGUAGES) {
    assert.match(speechPreview(language.code), /Luna/);
    assert.doesNotMatch(speechPreview(language.code), /jestem Nexus|I am Nexus/);
  }
  assert.match(speechPreview('pl-PL'), /asystentka Nexus AI.*Jestem gotowa/);
});

test('Polish conversation guidance uses natural feminine speech and concise greetings', () => {
  const context = speechReplyContext('pl-PL');
  assert.match(context, /naturalnie po polsku/);
  assert.match(context, /rodzaju żeńskim/);
  assert.match(context, /Cześć! W czym mogę ci pomóc/);
  assert.match(context, /Nie przedstawiaj się przy każdej odpowiedzi/);
  assert.match(context, /złożonym zadaniu zachowaj potrzebne szczegóły/);
  assert.match(context, /Nie dodawaj niepotwierdzonych informacji/);
});

test('speech strips formatting without changing facts, inline code or the displayed source', () => {
  const original = '# Wynik\n- **Cena:** 12,50 zł.\n- Zapisz `nexus_config.ts`.\n> [Dokumentacja](https://example.test/a_(b)) jest dostępna.\n*Jestem gotowa.*';
  const spoken = prepareSpeechText(original, 'pl-PL');
  assert.equal(spoken, 'Wynik\nCena: 12,50 zł.\nZapisz nexus_config.ts.\nDokumentacja jest dostępna.\nJestem gotowa.');
  assert.ok(original.startsWith('# Wynik'));
  assert.equal(prepareSpeechText(spoken, 'pl-PL'), spoken);
  for (const value of ['Cześć! W czym mogę ci pomóc?', 'Nie zmieniaj a_b ani 2 * 3.', 'https://example.test', '1. Zapisz plik.\n2. Uruchom testy.']) {
    assert.equal(prepareSpeechText(value, 'pl-PL'), value);
  }
});

test('code blocks are explicitly referenced instead of read as conversation', () => {
  for (const fence of ['```', '~~~']) {
    const source = `Gotowe.\n${fence}js\nconst x = 1;\n${fence}\nSprawdziłam wynik.`;
    assert.equal(prepareSpeechText(source, 'pl-PL'), 'Gotowe.\nKod znajduje się w odpowiedzi tekstowej.\nSprawdziłam wynik.');
    assert.match(prepareSpeechText(source, 'en-US'), /The code is in the written response/);
  }
});

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

test('android automatic voice is local female Paulina, not male Piper/Adam or online TTS', () => {
  const localVoices = [
    { ...voices[0], voiceURI: 'adam', name: 'Microsoft Adam - Polish (Poland)', default: true },
    { ...voices[0], voiceURI: 'paulina', name: 'Microsoft Paulina - Polish (Poland)', default: false },
    voices[1],
  ];
  assert.equal(selectSpeechVoice(localVoices, 'pl-PL', '', { localFemalePolish: true })?.voiceURI, 'paulina');
  assert.equal(selectSpeechVoice(localVoices, 'pl-PL', 'adam', { localFemalePolish: true })?.voiceURI, 'adam');
  assert.equal(selectSpeechVoice([localVoices[0], voices[1]], 'pl-PL', '', { localFemalePolish: true }), undefined);
  assert.equal(selectSpeechVoice([{ ...localVoices[1], localService: false }], 'pl-PL', '', { localFemalePolish: true }), undefined);
});
