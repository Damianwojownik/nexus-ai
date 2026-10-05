export const BING_CREATOR_URL = 'https://www.bing.com/images/create/ai-image-generator';
export const DEFAULT_EXTENSION_ID = 'ameboafdbmeapljnmnoiodhhaidnilnd';

type BrowserReply = { ok: boolean; code?: string; detail?: string; [key: string]: unknown };
export interface ExtensionRuntime {
  sendMessage(id: string, message: object, callback: (result?: BrowserReply) => void): void;
  lastError?: { message?: string };
}
interface PageElement { ref: string; tag: string; label: string }
function elements(reply: BrowserReply): PageElement[] {
  if (!Array.isArray(reply.elements)) throw new Error('Rozszerzenie nie zwróciło elementów strony Bing.');
  return reply.elements.filter((item: unknown): item is PageElement =>
    !!item && typeof item === 'object' && 'ref' in item && typeof item.ref === 'string'
    && 'tag' in item && typeof item.tag === 'string' && 'label' in item && typeof item.label === 'string');
}

export function getExtensionRuntime(): ExtensionRuntime | undefined {
  const browser = globalThis as typeof globalThis & { chrome?: { runtime?: ExtensionRuntime } };
  return browser.chrome?.runtime;
}

export async function startBingGeneration(
  runtime: ExtensionRuntime | undefined,
  extensionId: string,
  description: string,
  onProgress: (message: string) => void,
  wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 1000)),
): Promise<{ tabId: number; url: string }> {
  if (!description.trim() || description.length > 500) throw new Error('Podaj opis obrazu (1–500 znaków), np. „Wygeneruj obraz: niebieski robot w kosmosie”.');
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Ustaw poprawne ID rozszerzenia w ustawieniach.');
  if (!runtime?.sendMessage) throw new Error('Generowanie przez Bing wymaga zwykłego Edge/Chrome z rozszerzeniem Nexus Browser Bridge. Przeglądarka VS Code go nie obsługuje.');
  const send = (message: object): Promise<BrowserReply> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Rozszerzenie nie odpowiedziało. Sprawdź popup i oczekujące zgody.')), 100000);
    try {
      runtime.sendMessage(extensionId, message, result => {
        clearTimeout(timer);
        if (runtime.lastError) { reject(new Error(runtime.lastError.message || 'Brak połączenia z rozszerzeniem.')); return; }
        if (!result?.ok) { reject(new Error(`Rozszerzenie: ${result?.code || 'BRAK_ODPOWIEDZI'}${result?.detail ? ` — ${result.detail}` : ''}`)); return; }
        resolve(result);
      });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
  let token: string | undefined;
  try {
    const hello = await send({ type: 'hello' });
    if (hello.enabled !== true || hello.hostPermission !== true) throw new Error('W popupie Nexus Browser Bridge włącz połączenie i przyznaj dostęp do stron.');
    const connection = await send({ type: 'connect' });
    if (typeof connection.token !== 'string') throw new Error('Rozszerzenie nie zwróciło sesji.');
    token = connection.token;
    const call = (command: string, args: object) => send({ type: 'call', token, command, args });
    onProgress('Otwieram Bing. Zatwierdź otwarcie karty w popupie rozszerzenia.');
    const opened = await call('open', { url: BING_CREATOR_URL });
    if (typeof opened.tabId !== 'number') throw new Error('Nie otrzymano karty Bing.');
    const tabId = opened.tabId;
    let input: PageElement | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      await wait();
      const snapshot = await call('read', { tabId });
      if (typeof snapshot.url !== 'string' || new URL(snapshot.url).hostname !== 'www.bing.com') {
        throw new Error('Bing przekierował na inną stronę. Dokończ logowanie ręcznie i ponów polecenie.');
      }
      input = elements(snapshot).find(el => el.tag === 'textarea' && /describe.*image|opisz.*obraz/i.test(el.label));
      if (input) break;
    }
    if (!input) throw new Error('Nie znaleziono pola opisu Bing. Sprawdź otwartą kartę: logowanie, blokada lub zmiana strony.');
    onProgress('Wpisuję opis obrazu. Zatwierdź wpisanie w popupie rozszerzenia.');
    await call('type', { tabId, ref: input.ref, text: description });
    const snapshot = await call('read', { tabId });
    const generate = elements(snapshot).find(el => el.tag === 'button' && /^(?:Generate|Generuj|Utwórz)(?:\s|$)/i.test(el.label));
    if (!generate) throw new Error('Brak przycisku generowania Bing. Dokończ logowanie ręcznie; nie kupuj kredytów.');
    onProgress('Uruchamiam generowanie w chmurze Bing. Zatwierdź kliknięcie w popupie.');
    await call('click', { tabId, ref: generate.ref });
    return { tabId, url: BING_CREATOR_URL };
  } finally {
    if (token) {
      try { await send({ type: 'disconnect', token }); }
      catch (error) { console.error('Bing browser session disconnect failed:', error); }
    }
  }
}
