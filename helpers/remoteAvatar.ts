export class RemoteAvatar {
  private readonly base: URL;
  private readonly token: string;
  private readonly request: typeof fetch;

  constructor(endpoint: string, token: string, request: typeof fetch = fetch) {
    this.base = new URL(endpoint);
    if (this.base.protocol !== 'https:' || this.base.username || this.base.password || this.base.search || this.base.hash) {
      throw new Error('NEXUS_AVATAR_SERVER_URL must be an HTTPS server URL without credentials, query or fragment.');
    }
    this.base.pathname = `${this.base.pathname.replace(/\/$/, '')}/`;
    this.token = token;
    this.request = request;
  }

  private async call(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await this.request(new URL(path, this.base), {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Nexus avatar server: HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid avatar server response');
    return value as Record<string, unknown>;
  }

  async generate(image: Uint8Array, mime: 'image/png' | 'image/jpeg', text: string): Promise<string> {
    const value = await this.call('jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: Buffer.from(image).toString('base64'), mime, text }),
    });
    if (typeof value.jobId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.jobId)) throw new Error('Invalid remote avatar job ID');
    return value.jobId;
  }

  async result(jobId: string): Promise<{ status: 'processing' | 'complete' | 'error'; error?: string }> {
    const value = await this.call(`jobs/${encodeURIComponent(jobId)}`);
    if (value.status === 'processing' || value.status === 'complete') return { status: value.status };
    if (value.status === 'error' && typeof value.error === 'string') return { status: 'error', error: value.error };
    throw new Error('Unknown remote avatar job state');
  }

  async video(jobId: string): Promise<Response> {
    const response = await this.request(new URL(`jobs/${encodeURIComponent(jobId)}/video`, this.base), {
      headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('video/mp4')) {
      throw new Error(`Could not download remote avatar video: HTTP ${response.status}`);
    }
    return response;
  }
}
