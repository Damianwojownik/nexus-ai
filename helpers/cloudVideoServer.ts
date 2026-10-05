export type NexusVideoMode = 'text-to-video' | 'image-to-video' | 'speech-to-video' | 'character-animate';

export interface NexusVideoRequest {
  prompt: string;
  negative_prompt?: string;
  mode?: NexusVideoMode;
  model?: 'auto' | 'wan2.2' | 'hunyuanvideo';
  quality?: 'preview' | 'high' | 'ultra';
  width?: number;
  height?: number;
  fps?: number;
  duration_seconds?: number;
  seed?: number;
  image_url?: string;
  audio_url?: string;
}

export interface NexusVideoJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  result?: { backend: string; video_url: string; poster_url?: string; metadata?: Record<string, unknown> } | null;
  error?: string | null;
}

export class CloudVideoServerClient {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(
    baseUrl = process.env.NEXUS_VIDEO_SERVER_URL ?? '',
    token = process.env.NEXUS_VIDEO_SERVER_TOKEN ?? '',
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

  async health(): Promise<{ status: string; ok: boolean; message?: string }> {
    if (!this.configured()) return { status: 'NOT_CONFIGURED', ok: false, message: 'Set NEXUS_VIDEO_SERVER_URL.' };
    try {
      const response = await fetch(`${this.baseUrl}/health`, { headers: this.headers(), signal: AbortSignal.timeout(7000) });
      if (!response.ok) return { status: 'ERROR', ok: false, message: `Video cloud HTTP ${response.status}` };
      const body = await response.json().catch(() => ({})) as { ok?: boolean };
      return { status: body.ok === false ? 'ERROR' : 'CONNECTED', ok: body.ok !== false };
    } catch (error) {
      return { status: 'DISCONNECTED', ok: false, message: error instanceof Error ? error.message : 'Video cloud is unreachable' };
    }
  }

  async create(input: NexusVideoRequest): Promise<{ job_id: string; status: string }> {
    if (!this.configured()) throw new Error('Nexus Video Cloud is not configured');
    const response = await fetch(`${this.baseUrl}/v1/video/jobs`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Video cloud HTTP ${response.status}: ${await response.text()}`);
    return response.json() as Promise<{ job_id: string; status: string }>;
  }

  async get(jobId: string): Promise<NexusVideoJob> {
    if (!this.configured()) throw new Error('Nexus Video Cloud is not configured');
    const response = await fetch(`${this.baseUrl}/v1/video/jobs/${encodeURIComponent(jobId)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Video cloud HTTP ${response.status}: ${await response.text()}`);
    return response.json() as Promise<NexusVideoJob>;
  }
}
