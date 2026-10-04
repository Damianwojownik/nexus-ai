import type { CreationCommand } from './creationCommand.ts';

export type CreationFlow =
  | { step: 'image-description' }
  | { step: 'avatar-photo' }
  | { step: 'website-type'; description: string }
  | { step: 'website-brief'; websiteType: string };

export const WEBSITE_TYPES = ['Strona firmowa', 'Portfolio', 'Landing page', 'Sklep — makieta'] as const;

export function creationQuestion(flow: CreationFlow): { text: string; choices: readonly string[] } {
  switch (flow.step) {
    case 'image-description': return { text: 'Jaką grafikę mam przygotować? Opisz temat, kolory i styl.', choices: [] };
    case 'avatar-photo': return { text: 'Dodaj swoje zdjęcie przyciskiem plus, a potem napisz lub powiedz „ustaw awatara”. Ustawię portret; film wymaga osobnego renderera.', choices: [] };
    case 'website-type': return { text: 'Jaki rodzaj strony chcesz? Wybierz z listy albo opisz go własnymi słowami.', choices: WEBSITE_TYPES };
    case 'website-brief': return { text: 'Dla kogo ma być strona? Podaj nazwę, cel, najważniejsze treści i preferowane kolory.', choices: [] };
  }
}

export function advanceCreation(flow: CreationFlow, text: string, hasImage: boolean): CreationFlow | CreationCommand {
  const answer = text.trim();
  if (!answer) throw new Error('Odpowiedź nie może być pusta');
  switch (flow.step) {
    case 'image-description': return { kind: 'image', description: answer };
    case 'avatar-photo': return hasImage ? { kind: 'avatar' } : flow;
    case 'website-type':
      return flow.description ? { kind: 'website', description: `${answer}. ${flow.description}` }
        : { step: 'website-brief', websiteType: answer };
    case 'website-brief': return { kind: 'website', description: `${flow.websiteType}. ${answer}` };
  }
}

export function websitePrompt(description: string): string {
  return `Create a small, polished Polish website for this brief: ${description}
Return only one complete HTML document, starting with <!DOCTYPE html> and ending with </html>.
Use semantic HTML, responsive inline CSS, a clear heading, useful sections and contact information from the brief only.
Keep the entire document under 1600 characters: simple styling and at most three short sections. Close all tags.
Use no scripts, external resources or external links. Do not invent phone numbers, addresses, testimonials or prices.
Forms and shop controls are a static demonstration only. This is a local downloadable preview, not a production deployment.`;
}

export function websiteDocument(output: string): string {
  const html = output.trim().replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (html.length > 200000 || !/^(?:<!doctype html>\s*)?<html[\s>]/i.test(html)
    || !/<body[\s>]/i.test(html) || !/<\/body>/i.test(html) || !/<\/html>\s*$/i.test(html) || /<script[\s>]/i.test(html)) {
    throw new Error('Model nie zwrócił kompletnej statycznej strony HTML. Niczego nie opublikowano — spróbuj ponownie z krótszym opisem.');
  }
  const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\';">';
  return /<head[\s>]/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + policy)
    : html.replace(/<html[^>]*>/i, match => match + `<head>${policy}</head>`);
}
