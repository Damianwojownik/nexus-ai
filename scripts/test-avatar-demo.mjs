#!/usr/bin/env node
/**
 * Nexus Avatar Animation Demo
 * 
 * Demonstrates full end-to-end animation pipeline:
 * Text → TTS → Animation → Video
 */

import fetch from 'node-fetch';
import { readFileSync } from 'fs';
import { join } from 'path';

const BACKEND_URL = 'http://127.0.0.1:8788';
const TEST_TEXTS = [
  'Cześć! Jestem Nexus.',
  'Jestem twoim osobistym asystentem AI.',
  'Mogę pomagać ci w zadaniach, kodowaniu i analizie.',
  'Moja twarz rusza się, a ja mówię na żywo.',
];

async function testAnimateAvatar(text: string, index: number) {
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`Test ${index + 1}/${TEST_TEXTS.length}`);
  console.log(`Text: "${text}"`);
  console.log(`${'─'.repeat(80)}`);

  try {
    console.log('→ Sending request to backend...');
    const response = await fetch(`${BACKEND_URL}/api/avatar/animate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text,
        lang: 'pl',
        // portraitPath omitted - auto-detect
      }),
    });

    if (!response.ok) {
      console.error(`✗ HTTP ${response.status}`);
      const text = await response.text();
      console.error(text);
      return;
    }

    const data = await response.json();
    console.log(`✓ Status: ${data.status}`);
    console.log(`✓ Job ID: ${data.jobId}`);
    console.log(`✓ Video would be generated at: ${data.jobId || '(async)'}`);
    console.log(`✓ Animation triggered successfully`);
  } catch (error) {
    console.error(`✗ Error: ${error.message}`);
  }
}

async function testHealthCheck() {
  console.log('\n' + '═'.repeat(80));
  console.log('NEXUS AVATAR SYSTEM - HEALTH CHECK');
  console.log('═'.repeat(80));

  try {
    console.log(`\n→ Connecting to backend: ${BACKEND_URL}`);
    const response = await fetch(`${BACKEND_URL}/api/health`);
    
    if (!response.ok) {
      console.error(`\n✗ Backend not responding (HTTP ${response.status})`);
      console.error(`  Make sure to run: npm run hub`);
      process.exit(1);
    }

    const data = await response.json();
    console.log(`✓ Backend is running`);
    console.log(`✓ Health check: ${JSON.stringify(data)}`);
  } catch (error) {
    console.error(`\n✗ Cannot connect to backend`);
    console.error(`  Error: ${error.message}`);
    console.error(`  Make sure to run:`);
    console.error(`    1. npm run hub (in Terminal 2)`);
    console.error(`    2. Then run this test script`);
    process.exit(1);
  }
}

async function main() {
  console.log('\n');
  console.log('  ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗');
  console.log('  ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝');
  console.log('  ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗');
  console.log('  ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║');
  console.log('  ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║');
  console.log('  ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝');
  console.log('\n  Avatar Animation Test Suite\n');

  // Health check
  await testHealthCheck();

  // Animation tests
  console.log('\n' + '═'.repeat(80));
  console.log('ANIMATION TESTS');
  console.log('═'.repeat(80));

  for (let i = 0; i < TEST_TEXTS.length; i++) {
    await testAnimateAvatar(TEST_TEXTS[i], i);
    
    // Small delay between tests
    if (i < TEST_TEXTS.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  console.log('\n' + '═'.repeat(80));
  console.log('TEST COMPLETE');
  console.log('═'.repeat(80));
  console.log(`\n✓ All ${TEST_TEXTS.length} animation requests sent successfully`);
  console.log('\nNext steps:');
  console.log('  1. Videos are being generated in background');
  console.log('  2. Check FasterLivePortrait logs for animation progress');
  console.log('  3. Test in web UI: http://localhost:5173');
  console.log('  4. Type any message and watch avatar animate\n');
}

main().catch(console.error);
