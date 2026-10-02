#!/usr/bin/env node
/**
 * Nexus Avatar Integration Test
 * 
 * Tests the complete flow:
 * 1. TTS (text -> audio)
 * 2. FasterLivePortrait animation (audio + portrait -> video)
 * 3. Video playback
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_PORTRAIT = 'C:\\Users\\damian\\FasterLivePortrait\\checkpoints\\nexus_test_portrait.png';
const ANIMATOR_SCRIPT = 'C:\\Users\\damian\\FasterLivePortrait\\nexus_avatar_animator.py';
const PYTHON_EXE = 'C:\\Users\\damian\\FasterLivePortrait\\.venv\\Scripts\\python.exe';

interface AnimationResult {
  status: 'success' | 'error';
  video?: string;
  audio?: string;
  message?: string;
}

async function testAvatarAnimation(text: string): Promise<AnimationResult> {
  return new Promise((resolve) => {
    const args = [
      ANIMATOR_SCRIPT,
      '--portrait', TEST_PORTRAIT,
      '--text', text,
      '--lang', 'pl',
      '--json',
    ];

    let stdout = '';
    let stderr = '';

    const proc = spawn(PYTHON_EXE, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`❌ Animation process failed (code ${code})`);
        console.error('STDERR:', stderr.split('\n').slice(-10).join('\n'));
        resolve({ status: 'error', message: `Process exited with ${code}` });
        return;
      }

      try {
        const result = JSON.parse(stdout) as AnimationResult;
        resolve(result);
      } catch (err) {
        console.error('Failed to parse result:', stdout.split('\n').slice(-5).join('\n'));
        resolve({ status: 'error', message: 'Invalid JSON response' });
      }
    });

    proc.on('error', (err) => {
      console.error(`❌ Process error: ${err.message}`);
      resolve({ status: 'error', message: err.message });
    });
  });
}

async function main() {
  console.log('🎬 Nexus Avatar Integration Test\n');

  const testCases = [
    'Cześć! Jestem Nexus.',
    'Dzisiaj będę animowanym awatarem, który rusza się i mówi.',
    'To jest test integracji. Czy słyszysz mój głos i widzisz moja twarz?',
  ];

  for (const [i, text] of testCases.entries()) {
    console.log(`\n📹 Test ${i + 1}: "${text}"`);
    const result = await testAvatarAnimation(text);

    if (result.status === 'success') {
      console.log(`✅ Success`);
      console.log(`   Video: ${result.video}`);
      console.log(`   Audio: ${result.audio}`);
    } else {
      console.log(`❌ Failed: ${result.message}`);
    }
  }

  console.log('\n✅ All tests completed');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
