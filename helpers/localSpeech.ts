import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateSpeechText(text: unknown): string {
  if (typeof text !== 'string' || !text.trim() || text.length > 6000) {
    throw new Error('Speech text must contain 1 to 6000 characters.');
  }
  return text.trim();
}

export function validateSpeechWave(audio: Buffer): Buffer {
  if (audio.length < 44 || audio.length > 24 * 1024 * 1024
    || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Speech runtime returned invalid or oversized WAV audio.');
  }
  return audio;
}

export class LocalSpeech {
  private busy = false;
  private worker?: ChildProcessWithoutNullStreams;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly root = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'NexusAI', 'speech');
  private readonly python = join(this.root, 'venv', 'Scripts', 'python.exe');
  private readonly model = join(this.root, 'voices', 'pl_PL-darkman-medium.onnx');

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const worker = this.worker;
    this.worker = undefined;
    worker?.kill();
  }

  private run(textFile: string, audioFile: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.worker) {
      const worker = spawn(this.python, [fileURLToPath(new URL('../speech/synthesize.py', import.meta.url)), this.model, '--worker'], {
        windowsHide: true, env: { ...process.env, CUDA_VISIBLE_DEVICES: '-1', PYTHONUTF8: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.worker = worker;
      worker.stderr.resume();
      worker.on('error', error => console.error('CPU speech worker failed:', error.name));
      worker.stdin.on('error', () => console.error('CPU speech worker input closed unexpectedly.'));
      worker.once('exit', () => { if (this.worker === worker) this.worker = undefined; });
    }
    const worker = this.worker;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const lines = createInterface({ input: worker.stdout });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        lines.close();
        worker.off('error', onError);
        worker.off('exit', onExit);
        signal.removeEventListener('abort', onAbort);
        if (error) { this.close(); reject(error); }
        else {
          this.idleTimer = setTimeout(() => this.close(), 5 * 60 * 1000);
          this.idleTimer.unref();
          resolve();
        }
      };
      const onError = () => finish(new Error('CPU speech worker could not start.'));
      const onExit = () => finish(new Error('CPU speech worker stopped before returning audio.'));
      const onAbort = () => finish(new Error('CPU speech synthesis was canceled.'));
      const timeout = setTimeout(() => finish(new Error('CPU speech synthesis timed out.')), 60000);
      worker.once('error', onError);
      worker.once('exit', onExit);
      signal.addEventListener('abort', onAbort, { once: true });
      lines.once('line', line => {
        try {
          const result: unknown = JSON.parse(line);
          if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
            finish(new Error('CPU speech model failed to generate audio.'));
          } else finish();
        } catch { finish(new Error('CPU speech worker returned invalid data.')); }
      });
      worker.stdin.write(JSON.stringify({ textFile, audioFile }) + '\n', error => { if (error) onError(); });
    });
  }

  async health(): Promise<{ available: boolean; voice: string; language: string }> {
    try {
      await Promise.all([access(this.python), access(this.model), access(`${this.model}.json`)]);
      return { available: true, voice: 'Piper Darkman', language: 'pl-PL' };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { available: false, voice: 'Piper Darkman', language: 'pl-PL' };
      }
      throw error;
    }
  }

  async synthesize(text: string, signal: AbortSignal): Promise<Buffer> {
    const input = validateSpeechText(text);
    if (this.busy) throw new Error('Speech runtime is busy. Stop the previous utterance and try again.');
    this.busy = true;
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'nexus-speech-'));
      const textPath = join(directory, 'input.txt');
      const audioPath = join(directory, 'reply.wav');
      await writeFile(textPath, input, 'utf8');
      await this.run(textPath, audioPath, signal);
      return validateSpeechWave(await readFile(audioPath));
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        this.busy = false;
      }
    }
  }
}
