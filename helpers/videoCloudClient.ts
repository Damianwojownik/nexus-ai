export type NexusVideoMode =
  | 'text-to-video'
  | 'image-to-video'
  | 'speech-to-video'
  | 'character-animate';

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
  result?: {
    backend: string;
    video_url: string;
    poster_url?: string;
    metadata?: Record<string, unknown>;
  } | null;
  error?: string | null;
}

export class NexusVideoCloudClient {
  constructor(private readonly baseUrl: string) {}

  async create(request: NexusVideoRequest): Promise<{ job_id: string; status: string }> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/v1/video/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`Video Cloud HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  }

  async get(jobId: string): Promise<NexusVideoJob> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/v1/video/jobs/${encodeURIComponent(jobId)}`);
    if (!response.ok) throw new Error(`Video Cloud HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  }

  async wait(jobId: string, signal?: AbortSignal, intervalMs = 2000): Promise<NexusVideoJob> {
    while (!signal?.aborted) {
      const job = await this.get(jobId);
      if (job.status === 'completed' || job.status === 'failed') return job;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, intervalMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(signal.reason ?? new Error('aborted'));
        }, { once: true });
      });
    }
    throw signal?.reason ?? new Error('aborted');
  }
}
