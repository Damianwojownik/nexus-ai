import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const command = process.platform === 'win32'
  ? join(homedir(), '.local', 'bin', 'headroom.exe')
  : 'headroom';
const child = spawn(command, ['mcp', 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let nextId = 0;
let stderr = '';
child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });

function rejectPending(error) {
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(error);
  }
  pending.clear();
}

child.on('error', rejectPending);
child.stdin.on('error', rejectPending);
child.on('exit', code => rejectPending(new Error(`Headroom exited ${code}: ${stderr}`)));
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  let response;
  try { response = JSON.parse(line); }
  catch { rejectPending(new Error('Headroom emitted non-JSON MCP stdout')); return; }
  const item = pending.get(response.id);
  if (!item) return;
  pending.delete(response.id);
  clearTimeout(item.timer);
  if (response.error) item.reject(new Error(JSON.stringify(response.error)));
  else item.resolve(response.result);
});

function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Headroom ${method} timed out: ${stderr}`));
    }, 90000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function toolResult(response) {
  assert.equal(response.isError ?? false, false);
  return JSON.parse(response.content.find(item => item.type === 'text').text);
}

try {
  await request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'nexus-local-compression-check', version: '1.0.0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const source = JSON.stringify(Array.from({ length: 500 }, (_, id) => ({
    id, level: 'INFO', service: 'nexus-test', message: 'Synthetic successful health check',
  })));
  const compressed = toolResult(await request('tools/call', {
    name: 'headroom_compress', arguments: { content: source },
  }));
  assert.ok(compressed.original_tokens > compressed.compressed_tokens, 'Expected actual token reduction');
  assert.ok(compressed.hash, 'Expected retrievable original');
  const retrieved = toolResult(await request('tools/call', {
    name: 'headroom_retrieve', arguments: { hash: compressed.hash },
  }));
  assert.equal(retrieved.original_content, source, 'Original must be returned byte-for-byte');
  console.log(`PASS Headroom compression: ${compressed.original_tokens} -> ${compressed.compressed_tokens} tokens (${compressed.savings_percent}% saved); original retrieved byte-for-byte. No model API call.`);
} catch (error) {
  console.error(`FAIL Headroom compression: ${error.message}`);
  process.exitCode = 1;
} finally {
  rejectPending(new Error('Headroom check finished'));
  child.stdin.end();
  lines.close();
  const timer = setTimeout(() => child.kill(), 1000);
  timer.unref();
  child.once('exit', () => clearTimeout(timer));
}
