export interface NexusImageResult {
  image: Blob;
}

export async function generateNexusImage(
  baseUrl: string,
  prompt: string,
  fetcher: typeof fetch = fetch,
): Promise<NexusImageResult> {
  const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/api/image/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });

  if (!response.ok) {
    let detail = `Image Engine returned HTTP ${response.status}`;
    try {
      const body = await response.json() as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // Keep the HTTP status as the actionable error.
    }
    throw new Error(detail);
  }

  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'image/png') throw new Error('Nexus Image Engine returned an unsupported image format.');
  return { image: await response.blob() };
}
