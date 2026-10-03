export type SelfHostedImageHealth = {
  status: 'CONNECTED' | 'NOT_CONFIGURED' | 'DISCONNECTED' | 'ERROR';
  ok: boolean;
  message?: string;
  provider?: string;
  model?: string;
  mode?: string;
  device?: string;
  loaded?: boolean;
};

export type ImageGenerateInput = {
  prompt: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  guidanceScale?: number;
};

export type ImageGenerateResult = {
  contentType: string;
  data: Buffer;
  model?: string;
  seed?: number;
  steps?: number;
};

function optionalInteger(value: number | undefined, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

export class SelfHostedImageServerClient {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(
    baseUrl = process.env.NEXUS_IMAGE_SERVER_URL ?? '',
    token = process.env.NEXUS_IMAGE_SERVER_TOKEN ?? '',
  ) {
    this.baseUrl = baseUrl.trim().replace(/\/$/, '');
    this.token = token.trim();
  }

  configured(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  private headers(json = false): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  async health(): Promise<SelfHostedImageHealth> {
    if (!this.configured()) {
      return {
        status: 'NOT_CONFIGURED',
        ok: false,
        message: 'Set NEXUS_IMAGE_SERVER_URL and NEXUS_IMAGE_SERVER_TOKEN.',
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json().catch(() => ({})) as {
        ok?: boolean;
        provider?: string;
        model?: string;
        mode?: string;
        device?: string;
        loaded?: boolean;
        message?: string;
      };
      if (!response.ok || !body.ok) {
        return {
          status: 'ERROR',
          ok: false,
          provider: body.provider,
          model: body.model,
          mode: body.mode,
          device: body.device,
          loaded: body.loaded,
          message: body.message || `Image server HTTP ${response.status}`,
        };
      }
      return {
        status: 'CONNECTED',
        ok: true,
        provider: body.provider,
        model: body.model,
        mode: body.mode,
        device: body.device,
        loaded: body.loaded,
      };
    } catch (error) {
      return {
        status: 'DISCONNECTED',
        ok: false,
        message: error instanceof Error ? error.message : 'Image server is unreachable',
      };
    }
  }

  async generate(input: ImageGenerateInput): Promise<ImageGenerateResult> {
    if (!this.configured()) throw new Error('Self-hosted image server is not configured');
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error('prompt is required');
    if (prompt.length > 4000) throw new Error('prompt is too long');

    const width = optionalInteger(input.width, 'width', 512, 1536);
    const height = optionalInteger(input.height, 'height', 512, 1536);
    if (width !== undefined && width % 16 !== 0) throw new Error('width must be divisible by 16');
    if (height !== undefined && height % 16 !== 0) throw new Error('height must be divisible by 16');
    const steps = optionalInteger(input.steps, 'steps', 1, 4);
    const seed = optionalInteger(input.seed, 'seed', 0, 2147483647);
    const guidanceScale = input.guidanceScale;
    if (guidanceScale !== undefined && (!Number.isFinite(guidanceScale) || guidanceScale < 0 || guidanceScale > 10)) {
      throw new Error('guidanceScale must be from 0 to 10');
    }

    const response = await fetch(`${this.baseUrl}/v1/generate`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({
        prompt,
        width,
        height,
        steps,
        seed,
        guidance_scale: guidanceScale,
      }),
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    if (!response.ok) {
      let detail = `Image server HTTP ${response.status}`;
      try {
        const body = await response.json() as { detail?: string; error?: string };
        detail = body.detail || body.error || detail;
      } catch {}
      throw new Error(detail);
    }

    const parsedSeed = Number(response.headers.get('x-nexus-seed'));
    const parsedSteps = Number(response.headers.get('x-nexus-steps'));
    return {
      contentType: response.headers.get('content-type') || 'image/png',
      data: Buffer.from(await response.arrayBuffer()),
      model: response.headers.get('x-nexus-model') || undefined,
      seed: Number.isInteger(parsedSeed) ? parsedSeed : undefined,
      steps: Number.isInteger(parsedSteps) ? parsedSteps : undefined,
    };
  }
}
