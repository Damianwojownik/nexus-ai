/**
 * Avatar Animation Client
 *
 * Bridges Nexus Speech → FasterLivePortrait Animation → Video Stream
 * Supports both prerecorded audio and live TTS.
 */

import { EventEmitter } from 'events';

export interface AvatarAnimationRequest {
  portraitPath: string;
  text?: string;
  audioPath?: string;
  lang?: string;
  scale?: number;
  outputPath?: string;
}

export interface AvatarAnimationResult {
  status: 'success' | 'error';
  videoPath?: string;
  audioPath?: string;
  message?: string;
  durationMs?: number;
}

export type AvatarAnimationCallback = (result: AvatarAnimationResult) => void;

/**
 * Local avatar animation via subprocess.
 * Wraps nexus_avatar_animator.py
 */
export class LocalAvatarAnimator extends EventEmitter {
  private pythonExe: string;
  private animatorScript: string;
  private running = false;
  private queue: AvatarAnimationRequest[] = [];

  constructor(
    pythonExe: string = 'python',
    animatorScript: string = './nexus_avatar_animator.py'
  ) {
    super();
    this.pythonExe = pythonExe;
    this.animatorScript = animatorScript;
  }

  async animate(request: AvatarAnimationRequest): Promise<AvatarAnimationResult> {
    return new Promise((resolve) => {
      this.queue.push(request);
      this.processQueue();

      // Timeout: 120s
      const timeout = setTimeout(() => {
        resolve({
          status: 'error',
          message: 'Animation timeout after 120s'
        });
      }, 120_000);

      const onComplete = (result: AvatarAnimationResult) => {
        clearTimeout(timeout);
        resolve(result);
      };

      this.once(`animation:${request.portraitPath}`, onComplete);
    });
  }

  private async processQueue() {
    if (this.running || this.queue.length === 0) return;

    this.running = true;
    const request = this.queue.shift()!;

    try {
      const result = await this.invokeAnimator(request);
      this.emit(`animation:${request.portraitPath}`, result);
    } catch (error) {
      this.emit(`animation:${request.portraitPath}`, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.running = false;
      if (this.queue.length > 0) {
        setImmediate(() => this.processQueue());
      }
    }
  }

  private async invokeAnimator(request: AvatarAnimationRequest): Promise<AvatarAnimationResult> {
    const { spawn } = await import('child_process');

    return new Promise((resolve, reject) => {
      const args = [
        this.animatorScript,
        '--portrait', request.portraitPath,
        '--lang', request.lang || 'pl',
        '--mode', 'onnx',
        '--json',
      ];

      if (request.text) {
        args.push('--text', request.text);
      } else if (request.audioPath) {
        args.push('--audio', request.audioPath);
      } else {
        reject(new Error('Either text or audioPath required'));
        return;
      }

      if (request.outputPath) {
        args.push('--output', request.outputPath);
      }

      let stdout = '';
      let stderr = '';

      const proc = spawn(this.pythonExe, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', (err) => {
        reject(new Error(`Animator process error: ${err.message}`));
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Animator exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          const result = JSON.parse(stdout) as AvatarAnimationResult;
          resolve(result);
        } catch (err) {
          reject(new Error(`Failed to parse animator output: ${stdout}`));
        }
      });
    });
  }
}

/**
 * HTTP client to FasterLivePortrait Gradio API
 * Alternative for when subprocess is not available (e.g., in browser)
 */
export class RemoteAvatarAnimator {
  constructor(
    private baseUrl: string = 'http://127.0.0.1:9870'
  ) {}

  async animate(request: AvatarAnimationRequest): Promise<AvatarAnimationResult> {
    try {
      // FasterLivePortrait Gradio API expects form data or direct calls
      // See: /api/call/gpu_wrapped_execute_video
      const formData = new FormData();

      // Add portrait
      const portraitBlob = await fetch(`file://${request.portraitPath}`).then(r => r.blob());
      formData.append('portrait_image', portraitBlob, 'portrait.png');

      // Add audio if provided
      if (request.audioPath) {
        const audioBlob = await fetch(`file://${request.audioPath}`).then(r => r.blob());
        formData.append('driving_audio', audioBlob, 'audio.wav');
      }

      // Add other parameters
      formData.append('scale', String(request.scale ?? 1.0));

      const response = await fetch(
        `${this.baseUrl}/api/call/gpu_wrapped_execute_video`,
        {
          method: 'POST',
          body: formData,
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      // Extract video path from Gradio result
      if (data.data?.[7]?.name) {
        return {
          status: 'success',
          videoPath: data.data[7].name,
          audioPath: request.audioPath,
        };
      }

      throw new Error('Unexpected Gradio API response');
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

/**
 * Unified avatar animator: tries subprocess first, falls back to HTTP
 */
export class AvatarAnimator {
  private local?: LocalAvatarAnimator;
  private remote: RemoteAvatarAnimator;

  constructor(
    pythonExe?: string,
    animatorScript?: string,
    remoteUrl?: string
  ) {
    if (pythonExe) {
      this.local = new LocalAvatarAnimator(pythonExe, animatorScript || './nexus_avatar_animator.py');
    }
    this.remote = new RemoteAvatarAnimator(remoteUrl);
  }

  async animate(request: AvatarAnimationRequest): Promise<AvatarAnimationResult> {
    if (this.local) {
      try {
        return await this.local.animate(request);
      } catch {
        // Fall through to remote
      }
    }
    return this.remote.animate(request);
  }
}
