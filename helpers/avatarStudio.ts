export async function requestConversationVideo(
  baseUrl: string, text: string, cloudConsent: boolean,
  options: { signal: AbortSignal; onProgress: (attempt: number) => void; fetcher?: typeof fetch; intervalMs?: number },
): Promise<string> {
  if (!cloudConsent) throw new Error('Włącz zgodę na darmowy Colab w ustawieniach głosu. Nie wysłano danych.');
  if (!text.trim() || text.length > 5000) throw new Error('Odpowiedź wymaga od 1 do 5000 znaków.');
  options.signal.throwIfAborted();
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`${baseUrl}/api/avatar/conversation`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, cloudConsent }), signal: options.signal,
  });
  const job: unknown = await response.json();
  if (!response.ok) throw new Error(job && typeof job === 'object' && 'error' in job && typeof job.error === 'string'
    ? job.error : `Synchronizacja rozmowy: HTTP ${response.status}`);
  if (!job || typeof job !== 'object' || !('jobId' in job) || typeof job.jobId !== 'string'
    || !/^[a-f0-9-]{36}$/.test(job.jobId)) throw new Error('Brak poprawnego zadania synchronizacji rozmowy.');
  return waitForAvatarVideo(baseUrl, job.jobId, { ...options, fetcher, maxAttempts: 900 });
}

export async function waitForAvatarVideo(
  baseUrl: string,
  jobId: string,
  options: { signal: AbortSignal; onProgress: (attempt: number) => void; fetcher?: typeof fetch; intervalMs?: number; maxAttempts?: number },
): Promise<string> {
  const fetcher = options.fetcher ?? fetch;
  for (let attempt = 0; attempt < (options.maxAttempts ?? 150); attempt++) {
    options.signal.throwIfAborted();
    options.onProgress(attempt + 1);
    const response = await fetcher(`${baseUrl}/api/avatar/result/${encodeURIComponent(jobId)}`, { signal: options.signal });
    if (!response.ok) throw new Error(`Odczyt filmu: HTTP ${response.status}`);
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object' || !('status' in result)) throw new Error('Nieprawidłowa odpowiedź silnika filmu.');
    if (result.status === 'error') {
      throw new Error('error' in result && typeof result.error === 'string' ? result.error : 'Silnik filmu zgłosił błąd.');
    }
    if (result.status === 'complete') {
      if (!('videoUrl' in result) || typeof result.videoUrl !== 'string') throw new Error('Brak adresu gotowego filmu.');
      const video = new URL(result.videoUrl, baseUrl);
      if (video.origin !== new URL(baseUrl).origin || video.pathname !== `/api/avatar/video/${encodeURIComponent(jobId)}`
        || video.search || video.hash || video.username || video.password) {
        throw new Error('Silnik zwrócił niedozwolony adres filmu.');
      }
      return video.toString();
    }
    if (result.status !== 'processing') throw new Error('Nieznany stan generowania filmu.');
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); options.signal.removeEventListener('abort', abort); reject(options.signal.reason); };
      const timer = setTimeout(() => { options.signal.removeEventListener('abort', abort); resolve(); }, options.intervalMs ?? 2000);
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
    });
  }
  throw new Error('Przekroczono czas oczekiwania na film. Zadanie może nadal działać na serwerze.');
}

export async function requestPolishAudio(baseUrl: string, text: string, signal: AbortSignal): Promise<Blob> {
  if (!text.trim() || text.length > 6000) throw new Error('Lektor wymaga od 1 do 6000 znaków.');
  const response = await fetch(`${baseUrl}/api/speech/synthesize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal,
  });
  if (!response.ok) {
    const result: unknown = await response.json();
    throw new Error(result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
      ? result.error : `Lektor: HTTP ${response.status}`);
  }
  if (!response.headers.get('content-type')?.startsWith('audio/wav')) throw new Error('Silnik nie zwrócił dźwięku WAV.');
  const blob = await response.blob();
  if (blob.size < 44 || blob.size > 24 * 1024 * 1024) throw new Error('Nieprawidłowy rozmiar dźwięku.');
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const header = new TextDecoder().decode(bytes);
  if (!header.startsWith('RIFF') || header.slice(8) !== 'WAVE') throw new Error('Nieprawidłowy format dźwięku WAV.');
  return blob;
}
