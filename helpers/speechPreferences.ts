export const SPEECH_LANGUAGES = [
  { code: 'pl-PL', label: 'Polski' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'de-DE', label: 'Deutsch' },
  { code: 'fr-FR', label: 'Français' },
  { code: 'es-ES', label: 'Español' },
  { code: 'it-IT', label: 'Italiano' },
  { code: 'uk-UA', label: 'Українська' },
] as const;

export function speechLanguage(code: string) {
  return SPEECH_LANGUAGES.find(language => language.code === code) ?? SPEECH_LANGUAGES[0];
}

export interface VoiceChoice {
  voiceURI: string;
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
}

export function matchingVoices<T extends VoiceChoice>(voices: T[], language: string): T[] {
  const prefix = language.toLowerCase().split('-')[0];
  return voices.filter(voice => voice.lang.toLowerCase().split('-')[0] === prefix);
}

export function selectSpeechVoice<T extends VoiceChoice>(voices: T[], language: string, selectedURI: string, options: { localFemalePolish?: boolean } = {}): T | undefined {
  const matches = matchingVoices(voices, language);
  const exact = matches.filter(voice => voice.lang.toLowerCase() === language.toLowerCase());
  const preferred = exact.length ? exact : matches;
  const selected = matches.find(voice => voice.voiceURI === selectedURI);
  if (selected) return selected;
  if (options.localFemalePolish && language === 'pl-PL') {
    return exact.find(voice => voice.localService && /\bPaulina\b/i.test(voice.name));
  }
  return preferred.find(voice => /natural|neural|online/i.test(voice.name))
    ?? preferred.find(voice => voice.default)
    ?? preferred[0];
}

export function speechPreview(code: string): string {
  const samples: Record<string, string> = {
    'pl-PL': 'Cześć, jestem Luna, asystentka Nexus AI. Jestem gotowa do rozmowy. Tak brzmi mój głos.',
    'en-US': 'Hello, I am Luna, the Nexus AI assistant. This is my voice.',
    'en-GB': 'Hello, I am Luna, the Nexus AI assistant. This is my voice.',
    'de-DE': 'Hallo, ich bin Luna, die Assistentin von Nexus AI. So klingt meine Stimme.',
    'fr-FR': 'Bonjour, je suis Luna, votre assistante Nexus AI. Voici ma voix.',
    'es-ES': 'Hola, soy Luna, la asistente de Nexus AI. Esta es mi voz.',
    'it-IT': 'Ciao, sono Luna, la tua assistente Nexus AI. Questa è la mia voce.',
    'uk-UA': 'Привіт, я Luna, асистентка Nexus AI. Так звучить мій голос.',
  };
  return samples[speechLanguage(code).code];
}

export function speechReplyContext(code: string): string {
  const language = speechLanguage(code);
  if (language.code === 'pl-PL') {
    return 'Odpowiadaj naturalnie po polsku, chyba że poproszono o inny język. Pisz do rozmowy głosowej: krótkie zdania i proste słowa, bez Markdownu. Zwykle 1-3 zdania; przy złożonym zadaniu zachowaj potrzebne szczegóły. O sobie mów w rodzaju żeńskim. Nie przedstawiaj się przy każdej odpowiedzi. Powitanie: „Cześć! W czym mogę ci pomóc?”. Nie dodawaj niepotwierdzonych informacji.';
  }
  return `Reply in ${language.label} (${language.code}), unless the user explicitly requests another language. For ordinary conversation, answer directly and briefly (1-3 sentences), without narrating plans. Give full details when the task needs them.`;
}

export function prepareSpeechText(text: string, code: string): string {
  const codeNotices: Record<string, string> = {
    'pl-PL': 'Kod znajduje się w odpowiedzi tekstowej.',
    'en-US': 'The code is in the written response.',
    'en-GB': 'The code is in the written response.',
    'de-DE': 'Der Code steht in der Textantwort.',
    'fr-FR': 'Le code se trouve dans la réponse écrite.',
    'es-ES': 'El código está en la respuesta escrita.',
    'it-IT': 'Il codice è nella risposta scritta.',
    'uk-UA': 'Код наведено в текстовій відповіді.',
  };
  return text
    .replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[ \t]*$/gm, codeNotices[speechLanguage(code).code])
    .replace(/!?\[([^\]\n]+)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(?<!\w)\*([^\s*](?:[^*\n]*[^\s*])?)\*(?!\w)/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function createFinalSpeechSubmission(submit: (text: string) => void): (text: string) => boolean {
  let submitted = false;
  return text => {
    if (submitted || !text.trim()) return false;
    submitted = true;
    submit(text.trim());
    return true;
  };
}
