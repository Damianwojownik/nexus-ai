import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateSpeechText, validateSpeechWave } from './localSpeech.ts';

export function assertFreeConversationWorker(value: unknown): void {
  if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== true
    || !('engine' in value) || value.engine !== 'echomimic-v3'
    || !('suppliedAudio' in value) || value.suppliedAudio !== true
    || !('cost' in value) || value.cost !== 0) {
    throw new Error('Worker must confirm zero-cost EchoMimic with supplied audio. No paid or alternate-voice fallback.');
  }
}

export function conversationAudio(audio: Buffer): { durationSeconds: number; sha256: string } {
  validateSpeechWave(audio);
  let format = false;
  let samples = 0;
  let audible = false;
  if (audio.readUInt32LE(4) + 8 !== audio.length) throw new Error('Invalid speech WAV length');
  for (let offset = 12; offset + 8 <= audio.length;) {
    const id = audio.toString('ascii', offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > audio.length) throw new Error('Truncated speech WAV');
    if (id === 'fmt ') {
      if (size < 16 || audio.readUInt16LE(start) !== 1 || audio.readUInt16LE(start + 2) !== 1
        || audio.readUInt32LE(start + 4) !== 16000 || audio.readUInt16LE(start + 14) !== 16) {
        throw new Error('Conversation speech must be mono 16000 Hz 16-bit PCM');
      }
      format = true;
    }
    if (id === 'data') {
      if (size % 2) throw new Error('Invalid PCM sample length');
      samples += size;
      audible ||= audio.subarray(start, start + size).some(value => value !== 0);
    }
    offset = start + size + (size % 2);
  }
  const durationSeconds = samples / 32000;
  if (!format || !audible || durationSeconds < 0.2 || durationSeconds > 30) {
    throw new Error('EchoMimic accepts 0.2-30 seconds of speech. Shorten the reply; no audio was truncated.');
  }
  return { durationSeconds, sha256: createHash('sha256').update(audio).digest('hex') };
}

export async function synthesizeConversationSpeech(text: string, signal: AbortSignal): Promise<Buffer> {
  const input = validateSpeechText(text);
  signal.throwIfAborted();
  if (process.platform !== 'win32') throw new Error('Local female Paulina WAV currently requires Windows SAPI.');
  const directory = await mkdtemp(join(tmpdir(), 'nexus-paulina-'));
  try {
    const textFile = join(directory, 'reply.txt');
    const audioFile = join(directory, 'speech.wav');
    await writeFile(textFile, input, 'utf8');
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', fileURLToPath(new URL('../speech/paulina.ps1', import.meta.url)),
        '-TextFile', textFile, '-AudioFile', audioFile], {
        windowsHide: true, signal, timeout: 60000, stdio: ['ignore', 'ignore', 'pipe'],
      });
      let diagnostic = '';
      child.stderr.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-1000); });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve()
        : reject(new Error(`Local Paulina speech failed (${code}): ${diagnostic}`)));
    });
    signal.throwIfAborted();
    const audio = await readFile(audioFile);
    conversationAudio(audio);
    return audio;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
