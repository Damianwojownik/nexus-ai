export interface ImageCreationCommand {
  kind: 'image';
  description: string;
}

export function parseCreationCommand(text: string): ImageCreationCommand | null {
  const trimmed = text.trim();
  const withImageType = trimmed.match(/^(?:wygeneruj|generuj)\s+(?:mi\s+)?(?:zdjęcie|zdjecie|obraz(?:ek)?|grafikę|grafike)(?=\s|[:—-]|$)\s*[:—-]?\s*(.*)$/iu);
  if (withImageType) return { kind: 'image', description: withImageType[1].trim() };

  const direct = trimmed.match(/^(?:wygeneruj|generuj)\s+(?:mi\s+)?(.+)$/iu);
  if (!direct) return null;
  return {
    kind: 'image',
    description: direct[1].trim().replace(/^to\b\s*/iu, '').trim(),
  };
}
