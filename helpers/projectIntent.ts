export function normalizeIntentText(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

export function isProjectCreationIntent(text: string): boolean {
  const value = normalizeIntentText(text);
  const actions = ['stworz','zbuduj','zaprojektuj','napisz','zrob','chce'];
  const products = ['aplikacj',' app','stron','serwis','panel','dashboard','program','projekt','frontend','backend',' api'];
  return actions.some((word) => value.includes(word))
    && products.some((word) => value.includes(word));
}
