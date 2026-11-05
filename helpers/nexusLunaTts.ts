import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const LUNA_VOICE = 'pl-PL-ZofiaNeural';
const MAX_CHARACTERS = 600;
const MAX_AUDIO_BYTES = 3_000_000;

/** Independent Nexus voice synthesis; no Ezostylia runtime or API dependency. */
export function validateLunaSpeech(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Tekst głosu musi być ciągiem znaków.');
  const text = value.replace(/https?:\/\/\S+/g, '').replace(/[✦*_#>`~|]/g, '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_CHARACTERS) throw new Error('Tekst głosu musi mieć od 1 do 600 znaków.');
  return text;
}

export async function synthesizeLunaVoice(value: unknown): Promise<Buffer> {
  const text = validateLunaSpeech(value);
  const dir = await mkdtemp(join(tmpdir(), 'nexus-luna-'));
  const output = join(dir, 'speech.mp3');
  const executable = process.env.NEXUS_LUNA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  try {
    await new Promise<void>((resolve, reject) => {
      // spawn with argument array, never shell; the user text cannot execute commands.
      const child = spawn(executable, ['-m', 'edge_tts', '--voice', LUNA_VOICE, '--text', text, '--write-media', output], { shell: false, stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => child.kill(), 25_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error('Silnik ZofiaNeural jest niedostępny. Zainstaluj w lokalnym Pythonie: python -m pip install edge-tts'));
      });
    });
    const audio = await readFile(output);
    if (!audio.length || audio.length > MAX_AUDIO_BYTES) throw new Error('Nieprawidłowy rozmiar nagrania Luny.');
    return audio;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
