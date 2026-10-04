export type CreationCommand =
  | { kind: 'image'; description: string }
  | { kind: 'avatar' }
  | { kind: 'animation'; text: string };

export function parseCreationCommand(text: string): CreationCommand | null {
  const trimmed = text.trim();
  const image = trimmed.match(/^(?:wygeneruj|generuj|stw[oó]rz|zrób|zrob)\s+(?:mi\s+)?(?:zdjęcie|zdjecie|obraz(?:ek)?|grafikę|grafike)(?=\s|[:—-]|$)\s*[:—-]?\s*(.*)$/iu);
  if (image) return { kind: 'image', description: image[1].trim() };
  const directImage = trimmed.match(/^(?:wygeneruj|generuj)\s+(?:mi\s+)?(.+)$/iu);
  if (directImage) {
    const description = directImage[1].trim().replace(/^to\b\s*/iu, '').trim();
    return { kind: 'image', description };
  }
  if (/^(?:stw[oó]rz|zrób|zrob|ustaw|utw[oó]rz)\s+(?:mi\s+)?(?:awatar|awatara|avatar)\b/iu.test(trimmed)) {
    return { kind: 'avatar' };
  }
  const animation = trimmed.match(/^(?:animuj|ożyw|ozyw)\s*(?:awatar(?:a)?|zdjęcie|zdjecie|postać|postac)?\s*[:—-]?\s*(.*)$/iu);
  if (animation) return { kind: 'animation', text: animation[1].trim() };
  return null;
}
