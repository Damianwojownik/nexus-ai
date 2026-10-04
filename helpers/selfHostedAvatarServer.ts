export type SelfHostedAvatarHealth = {
  status: 'CONNECTED' | 'NOT_CONFIGURED' | 'DISCONNECTED' | 'ERROR';
  ok: boolean;
  message?: string;
  provider?: string;
  mode?: string;
};

export type AvatarRenderInput = {
  sourceImageBase64: string;
  sourceImageMime?: string;
  audioBase64?: string;
  audioMime?: string;
  drivingVideoBase64?: string;
  drivingVideoMime?: string;
  subjectMode?: 'auto' | 'human' | 'animal';
};

export type AvatarRenderResult = {
  contentType: string;
  data: Buffer;
};

function cleanBase64(value: string): string {
  const comma = value.indexOf(',');
  return comma >= 0 && value.slice(0, comma).includes('base64') ? value.slice(comma + 1) : value;
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(cleanBase64(value), 'base64'));
}

export class SelfHostedAvatarServerClient {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(
    baseUrl = process.env.NEXUS_AVATAR_SERVER_URL ?? '',
    token = process.env.NEXUS_AVATAR_SERVER_TOKEN ?? '',
  ) {
    this.baseUrl = baseUrl.trim().replace(/\/$/, '');
    this.token = token.trim();
  }

  configured(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.token}` };
  }

  async health(): Promise<SelfHostedAvatarHealth> {
    if (!this.configured()) {
      return {
        status: 'NOT_CONFIGURED',
        ok: false,
        message: 'Set NEXUS_AVATAR_SERVER_URL and NEXUS_AVATAR_SERVER_TOKEN.',
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return { status: 'ERROR', ok: false, message: `Avatar server HTTP ${response.status}` };
      }
      const body = await response.json() as { ok?: boolean; provider?: string; mode?: string; missing?: string[] };
      if (!body.ok) {
        return {
          status: 'ERROR',
          ok: false,
          provider: body.provider,
          mode: body.mode,
          message: body.missing?.length ? `Missing: ${body.missing.join(', ')}` : 'Avatar server is not ready',
        };
      }
      return { status: 'CONNECTED', ok: true, provider: body.provider, mode: body.mode };
    } catch (error) {
      return {
        status: 'DISCONNECTED',
        ok: false,
        message: error instanceof Error ? error.message : 'Avatar server is unreachable',
      };
    }
  }

  async render(input: AvatarRenderInput): Promise<AvatarRenderResult> {
    if (!this.configured()) {
      throw new Error('Self-hosted avatar server is not configured');
    }
    if (!input.sourceImageBase64) throw new Error('sourceImageBase64 is required');
    if (!input.audioBase64 && !input.drivingVideoBase64) {
      throw new Error('audioBase64 or drivingVideoBase64 is required');
    }

    const form = new FormData();
    form.append(
      'source_image',
      new Blob([new Uint8Array(decodeBase64(input.sourceImageBase64))], { type: input.sourceImageMime || 'image/png' }),
      'source.png',
    );
    form.append('mode', input.subjectMode || 'auto');
    if (input.audioBase64) {
      form.append(
        'audio',
        new Blob([new Uint8Array(decodeBase64(input.audioBase64))], { type: input.audioMime || 'audio/wav' }),
        'speech.wav',
      );
    } else if (input.drivingVideoBase64) {
      form.append(
        'driving_video',
        new Blob([new Uint8Array(decodeBase64(input.drivingVideoBase64))], { type: input.drivingVideoMime || 'video/mp4' }),
        'driving.mp4',
      );
    }

    const response = await fetch(`${this.baseUrl}/v1/render`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (!response.ok) {
      let detail = `Avatar server HTTP ${response.status}`;
      try {
        const body = await response.json() as { detail?: string; error?: string };
        detail = body.detail || body.error || detail;
      } catch {}
      throw new Error(detail);
    }
    return {
      contentType: response.headers.get('content-type') || 'video/mp4',
      data: Buffer.from(await response.arrayBuffer()),
    };
  }
}
