import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Development launcher: one application, one command, two cooperating local processes.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const services = [
  { label: 'Agent Hub + Luna voice', args: ['--experimental-strip-types', 'helpers/agentHubRuntime.ts'] },
  { label: 'Nexus UI', args: ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'] },
];

let stopping = false;
const children = [];

function stopAll(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const { process: child } of children) {
    if (child.exitCode === null && !child.killed) child.kill(signal);
  }
}

for (const service of services) {
  const child = spawn(process.execPath, service.args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  });
  children.push({ label: service.label, process: child });
  child.once('error', (error) => {
    console.error('[Nexus] ' + service.label + ': ' + error.message);
    process.exitCode = 1;
    stopAll();
  });
  child.once('exit', (code, signal) => {
    if (stopping) return;
    console.error('[Nexus] ' + service.label + ' zakończył działanie (' + (signal ?? code ?? 'unknown') + ').');
    process.exitCode = typeof code === 'number' && code !== 0 ? code : 1;
    stopAll();
  });
}

process.once('SIGINT', () => stopAll('SIGINT'));
process.once('SIGTERM', () => stopAll('SIGTERM'));
console.log('[Nexus] Interfejs: http://127.0.0.1:5173');
console.log('[Nexus] Lokalny Agent Hub i głos Luny: http://127.0.0.1:8788');
