export type ProviderChoice = 'economy' | 'auto' | 'chatgpt-plan' | 'copilot' | 'ollama';
export type RoutedProvider = Exclude<ProviderChoice, 'economy'>;

export function resolveProvider(choice: ProviderChoice, message: string): RoutedProvider {
  if (choice !== 'economy') return choice;
  const text = message.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /\?|(?:^|[^\p{L}])(?:dlaczego|jak|czy|ktory|ktora|pytani\p{L}*|analiz\p{L}*|przeanaliz\p{L}*|decyz\p{L}*|zdecyduj|zastan\p{L}*|strateg\p{L}*|porown\p{L}*|ocen\p{L}*|z?redag\p{L}*|redakc\p{L}*|seo|audyt\p{L}*|sprawdz\p{L}*|zweryfik\p{L}*|finaln\p{L}*|why|how|decision|analysis|strategy|compare)(?:$|[^\p{L}])/u.test(text)
    ? 'chatgpt-plan' : 'ollama';
}
