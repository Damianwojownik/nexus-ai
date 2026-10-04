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

export function selectSpeechVoice<T extends VoiceChoice>(voices: T[], language: string, selectedURI: string): T | undefined {
  const matches = matchingVoices(voices, language);
  const exact = matches.filter(voice => voice.lang.toLowerCase() === language.toLowerCase());
  const preferred = exact.length ? exact : matches;
  return matches.find(voice => voice.voiceURI === selectedURI)
    ?? preferred.find(voice => /natural|neural|online/i.test(voice.name))
    ?? preferred.find(voice => voice.default)
    ?? preferred[0];
}

export function speechPreview(code: string): string {
  const samples: Record<string, string> = {
    'pl-PL': 'Cześć, jestem Nexus. Tak brzmi mój głos.',
    'en-US': 'Hello, I am Nexus. This is my voice.',
    'en-GB': 'Hello, I am Nexus. This is my voice.',
    'de-DE': 'Hallo, ich bin Nexus. So klingt meine Stimme.',
    'fr-FR': 'Bonjour, je suis Nexus. Voici ma voix.',
    'es-ES': 'Hola, soy Nexus. Esta es mi voz.',
    'it-IT': 'Ciao, sono Nexus. Questa è la mia voce.',
    'uk-UA': 'Привіт, я Nexus. Так звучить мій голос.',
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
