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
  return `Reply in ${language.label} (${language.code}), unless the user explicitly requests another language. For ordinary conversation, answer directly and briefly (1-3 sentences), without narrating plans. Give full details when the task needs them.`;
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
