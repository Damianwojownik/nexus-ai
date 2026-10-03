export type NexusCreationKind = 'image' | 'video' | 'speech';

export interface NexusCreationCommand {
  kind: NexusCreationKind;
  description: string;
}

const trimLead = (value: string) => value.trim().replace(/^[:—-]\s*/u, '').trim();

export function parseCreationCommand(text: string): NexusCreationCommand | null {
  const trimmed = text.trim();
  const patterns: Array<[NexusCreationKind, RegExp]> = [
    ['video', /^(?:wygeneruj|generuj|zrób|stwórz)\s+(?:mi\s+)?(?:film|filmik|wideo|video)(?=\s|[:—-]|$)\s*(.*)$/iu],
    ['image', /^(?:wygeneruj|generuj|zrób|stwórz)\s+(?:mi\s+)?(?:zdjęcie|zdjecie|obraz(?:ek)?|grafikę|grafike)(?=\s|[:—-]|$)\s*(.*)$/iu],
    ['speech', /^(?:wygeneruj|generuj|zrób|stwórz)\s+(?:mi\s+)?(?:lektor(?:a)?|głos|glos|narrację|narracje|audio)(?=\s|[:—-]|$)\s*(.*)$/iu],
  ];
  for (const [kind, pattern] of patterns) {
    const match = trimmed.match(pattern);
    if (match) return { kind, description: trimLead(match[1] ?? '') };
  }
  return null;
}
