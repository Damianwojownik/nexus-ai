export interface AvatarBatchRequest {
  version: 1;
  kind: 'nexus-face-job';
  requestId: string;
  mime: 'image/png' | 'image/jpeg';
  image: string;
  text: string;
}

export function createAvatarBatchRequest(portraitData: string, text: string, requestId: string): AvatarBatchRequest {
  const script = text.trim();
  if (!script || script.length > 300) throw new Error('Zadanie Colab wymaga od 1 do 300 znaków wypowiedzi.');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId)) {
    throw new Error('Nieprawidłowy identyfikator zadania Colab.');
  }
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(portraitData);
  if (!match || match[2].length % 4 !== 0) throw new Error('Zadanie wymaga zdjęcia PNG lub JPEG.');
  const binary = atob(match[2]);
  if (!binary.length || binary.length > 5 * 1024 * 1024) throw new Error('Zdjęcie może mieć maksymalnie 5 MB.');
  const signature = match[1] === 'png' ? '\x89PNG\r\n\x1a\n' : '\xff\xd8\xff';
  if (!binary.startsWith(signature)) throw new Error('Zawartość zdjęcia nie odpowiada formatowi.');
  return { version: 1, kind: 'nexus-face-job', requestId, mime: match[1] === 'png' ? 'image/png' : 'image/jpeg', image: match[2], text: script };
}

export function validateAvatarVideoFile(file: Pick<File, 'name' | 'size'>): void {
  if (!/\.mp4$/i.test(file.name)) throw new Error('Wybierz wynikowy film MP4 z Colab.');
  if (!file.size || file.size > 256 * 1024 * 1024) throw new Error('Film musi mieć od 1 bajta do 256 MB.');
}
