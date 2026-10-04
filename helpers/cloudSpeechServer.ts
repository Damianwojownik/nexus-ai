export interface NexusSpeechInput {
  text: string;
  voice?: string;
  language?: string;
  format?: 'mp3' | 'wav' | 'ogg';
}

export class CloudSpeechServerClient {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(
    baseUrl = process.env.NEXUS_SPEECH_SERVER_URL ?? '',
    token = process.env.NEXUS_SPEECH_SERVER_TOKEN ?? '',
  ) {
    this.baseUrl = baseUrl.trim().replace(/\/$/, '');
    this.token = token.trim();
  }

  configured(): boolean { return Boolean(this.baseUrl); }

  private headers(json = false): HeadersInit {
    return {
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  async health(): Promise<{ status: string; ok: boolean; provider?: string; message?: string }> {
    if (!this.configured()) return { status: 'NOT_CONFIGURED', ok: false, message: 'Set NEXUS_SPEECH_SERVER_URL.' };
    try {
      const response = await fetch(`${this.baseUrl}/health`, { headers: this.headers(), signal: AbortSignal.timeout(7000) });
      const body = await response.json().catch(() => ({})) as { ok?: boolean; provider?: string; message?: string };
      if (!response.ok || body.ok === false) return { status: 'ERROR', ok: false, provider: body.provider, message: body.message || `Speech cloud HTTP ${response.status}` };
      return { status: 'CONNECTED', ok: true, provider: body.provider };
    } catch (error) {
      return { status: 'DISCONNECTED', ok: false, message: error instanceof Error ? error.message : 'Speech cloud is unreachable' };
    }
  }

  async synthesize(input: NexusSpeechInput): Promise<{ data: Buffer; contentType: string; voice?: string }> {
    if (!this.configured()) throw new Error('Nexus Speech Cloud is not configured');
    const text = input.text.trim();
    if (!text) throw new Error('text is required');
    if (text.length > 12000) throw new Error('speech text is too long');
    const response = await fetch(`${this.baseUrl}/v1/speech`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({
        text,
        voice: input.voice,
        language: input.language || 'pl-PL',
        format: input.format || 'mp3',
      }),
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
    if (!response.ok) throw new Error(`Speech cloud HTTP ${response.status}: ${await response.text()}`);
    return {
      data: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') || 'audio/mpeg',
      voice: response.headers.get('x-nexus-voice') || input.voice,
    };
  }
}
