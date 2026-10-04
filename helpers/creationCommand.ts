export type CreationCommand =
  | { kind: 'image'; description: string }
  | { kind: 'avatar' }
  | { kind: 'website'; description: string }
  | { kind: 'animation'; text: string };

export function parseCreationCommand(text: string): CreationCommand | null {
  const trimmed = text.trim();
  const action = '(?:wygeneruj|generuj|stw[oó]rz|zrób|zrob|ustaw|utw[oó]rz|chc[eę](?:\\s+(?:zrobi[cć]|stworzy[cć]|utworzy[cć]))?)\\s+(?:mi\\s+)?';
  if (new RegExp(`^${action}(?:awatar|awatara|avatar)(?=\\s|[:—-]|$)`, 'iu').test(trimmed)) return { kind: 'avatar' };
  const website = trimmed.match(new RegExp(`^${action}(?:stron[eę]|stron[eę]\\s+internetow[aą]|witryn[eę])(?=\\s|[:—-]|$)\\s*[:—-]?\\s*(.*)$`, 'iu'));
  if (website) return { kind: 'website', description: website[1].trim() };
  const image = trimmed.match(new RegExp(`^${action}(?:zdjęcie|zdjecie|obraz(?:ek)?|grafik[eę])(?=\\s|[:—-]|$)\\s*[:—-]?\\s*(.*)$`, 'iu'));
  if (image) return { kind: 'image', description: image[1].trim() };
  const directImage = trimmed.match(/^(?:wygeneruj|generuj)\s+(?:mi\s+)?(.+)$/iu);
  if (directImage) {
    const description = directImage[1].trim().replace(/^to\b\s*/iu, '').trim();
    return { kind: 'image', description };
  }
  const animation = trimmed.match(/^(?:animuj|ożyw|ozyw)\s*(?:awatar(?:a)?|zdjęcie|zdjecie|postać|postac)?\s*[:—-]?\s*(.*)$/iu);
  if (animation) return { kind: 'animation', text: animation[1].trim() };
  return null;
}
