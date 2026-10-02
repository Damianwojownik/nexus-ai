import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter } from './modelRouter.ts';
import type { ModelProvider } from './modelRouter.ts';

const makeProvider = (name:string, mode:'LOCAL'|'CLOUD', role:'PRIMARY_ORCHESTRATOR'|'SUBAGENT', value:string, fail=false): ModelProvider => ({
  name, mode, role,
  async generate(){ if(fail) throw new Error('remote unavailable'); return value; },
  async checkHealth(){ return { status: 'CONNECTED' as const }; },
  async listModels(){ return []; },
});

test('AUTO prefers remote provider', async () => {
  const local=makeProvider('Ollama','LOCAL','SUBAGENT','local');
  const cloud=makeProvider('Cloud','CLOUD','PRIMARY_ORCHESTRATOR','cloud');
  assert.equal(await new ModelRouter('AUTO',[local],cloud).route('hello'),'cloud');
});

test('AUTO falls back to local provider', async () => {
  const local=makeProvider('Ollama','LOCAL','SUBAGENT','local');
  const cloud=makeProvider('Cloud','CLOUD','PRIMARY_ORCHESTRATOR','cloud',true);
  assert.equal(await new ModelRouter('AUTO',[local],cloud).route('hello'),'local');
});
