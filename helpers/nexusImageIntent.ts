export type NexusImageOrientation = 'square' | 'portrait' | 'landscape';

export type NexusImageDimensions = {
  width: number;
  height: number;
  orientation: NexusImageOrientation;
};

const imageCommandPattern = /\b(wygeneruj|generuj|stwórz|stworz|zrób|zrob|narysuj|create|generate|make)\b/i;
const imageNounPattern = /\b(obraz(?:ek|u|a)?|zdjęci(?:e|a)|zdjecie|grafik(?:a|ę|e)|image|photo|picture)\b/i;

export function isImageGenerationIntent(text: string): boolean {
  return imageCommandPattern.test(text) && imageNounPattern.test(text);
}

export function imageDimensionsForText(text: string): NexusImageDimensions {
  if (/\b(pionow[yae]|portret(?:owy|owa|owe)?|portrait|tall|pełna postać|pelna postac)\b/i.test(text)) {
    return { width: 768, height: 1024, orientation: 'portrait' };
  }
  if (/\b(poziom[yae]|krajobraz(?:owy|owa|owe)?|landscape|wide|panoram(?:a|iczny|iczna))\b/i.test(text)) {
    return { width: 1024, height: 768, orientation: 'landscape' };
  }
  return { width: 1024, height: 1024, orientation: 'square' };
}

export function buildFallbackImagePrompt(text: string): string {
  const cleaned = text
    .replace(imageCommandPattern, '')
    .replace(imageNounPattern, '')
    .replace(/^[\s:,.\-–—]+/, '')
    .trim();
  const subject = cleaned || text.trim();
  return `${subject}. Photorealistic, natural anatomy, realistic skin and materials, coherent hands and fingers, accurate proportions, sharp subject detail, physically plausible lighting, cinematic but natural color, clean composition, no text, no watermark.`;
}
