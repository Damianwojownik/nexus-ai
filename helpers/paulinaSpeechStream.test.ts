import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { PaulinaSpeechStream, parsePaulinaSpeechEvent } from './paulinaSpeechStream.ts';
import { parsePaulinaSpeechEvent as parseBrowserEvent, decodePaulinaAudioBase64 } from './paulinaSpeechProtocol.ts';
import { PcmStreamPlayer } from './pcmStream.ts';

const pcm = { encoding: 'PCM16LE', sampleRate: 16000, channels: 1, bitsPerSample: 16 } as const;
const identity = { voice: 'Microsoft Paulina Desktop', language: 'pl-PL', cost: 0, device: 'cpu' } as const;
const ready = { type: 'ready', ...pcm, ...identity, available: true, pcm: true, reason: null };
const start = { type: 'start', requestId: 'test', ...pcm, ...identity };
function audio(sequence = 0, startSample = 0, sampleCount = 320) {
  const bytes = Buffer.alloc(sampleCount * 2, 1);
  return { type: 'audio', requestId: 'test', ...pcm, sequence, startSample, sampleCount,
    bytesBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') };
}
const phoneme = { type: 'phoneme', requestId: 'test', source: 'System.Speech.PhonemeReached',
  symbol: 'ʂ', nextSymbol: '\u032f', kind: 'native-token', audioPositionMs: 0, durationMs: 20, emphasis: 0 };
const viseme = { type: 'viseme', requestId: 'test', source: 'System.Speech.VisemeReached',
  viseme: 16, nextViseme: 0, audioPositionMs: 0, durationMs: 20, emphasis: 0 };
const end = { type: 'end', requestId: 'test', totalSamples: 320, chunks: 1, phonemes: 1, visemes: 1,
  audioDurationMs: 20, synthesisMs: 30, firstPcmMs: 5 };
const parse = (packet: unknown) => parsePaulinaSpeechEvent(JSON.stringify(packet));
function factory(mode = 'normal', children: ChildProcessWithoutNullStreams[] = []) {
  return () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import {createInterface} from 'node:readline';
      const ready=${JSON.stringify(ready)}, list=${JSON.stringify([start, audio(), phoneme, viseme, end])};
      const emit=p=>process.stdout.write(JSON.stringify(p)+'\\n');
      if (${JSON.stringify(mode)}!=='no-ready') emit(ready);
      for await(const line of createInterface({input:process.stdin})) {
        const {requestId}=JSON.parse(line), mode=${JSON.stringify(mode)};
        const packets=list.map(p=>({...p,requestId}));
        if(mode==='oversized') { process.stdout.write('x'.repeat(9000)+'\\n'); continue; }
        if(mode==='wrong-id') packets[0].requestId='stale';
        if(mode==='no-start') packets.shift();
        if(mode==='gap') packets[1].startSample=1;
        if(mode==='sequence') packets[1].sequence=1;
        if(mode==='totals') packets.at(-1).chunks=2;
        if(mode==='nonmonotonic') packets.splice(3,0,{...packets[2],audioPositionMs:1},packets[2]);
        for(const p of (mode==='hang'?packets.slice(0,1):packets)) emit(p);
      }`], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    children.push(child); return child;
  };
}
test('strict packet parser preserves real native token provenance and validates raw PCM', () => {
  for (const packet of [ready, start, audio(), phoneme, viseme, end,
    { type: 'error', requestId: 'test', code: 'SYNTHESIS_FAILED', message: 'Failed' }])
    assert.deepEqual(parse(packet), packet);
  for (const [symbol, kind] of [['\u032f', 'modifier'], ['ʲ', 'modifier'], ['\u0004', 'boundary']] as const) {
    const event = parse({ ...phoneme, symbol, kind });
    assert(event.type === 'phoneme'); assert.equal(event.symbol, symbol);
  }
  for (const invalid of [
    null, [], { ...ready, pcm: false }, { ...ready, voice: 'Another voice' }, { ...ready, cost: 1 },
    { ...ready, device: 'gpu' }, { ...ready, language: 'en-US' }, { ...audio(), requestId: '' },
    { ...audio(), sequence: -1 }, { ...audio(), startSample: 0.5 }, { ...audio(), sampleRate: 48000 },
    { ...audio(), channels: 2 }, { ...audio(), sampleCount: 641 }, { ...audio(), bytesBase64: audio().bytesBase64 + ' ' },
    { ...audio(), sha256: 'not-a-digest' }, { ...audio(), extra: true }, { ...end, totalSamples: 0 },
    { ...end, firstPcmMs: 40 }, { ...viseme, viseme: 22 }, { ...viseme, durationMs: -1 }, { ...viseme, emphasis: '0' },
    { ...phoneme, symbol: '\u0004' }, { ...phoneme, symbol: '\u032f' }, { ...phoneme, source: 'estimated' },
  ]) {
    assert.throws(() => parse(invalid));
    assert.throws(() => parseBrowserEvent(JSON.stringify(invalid)));
  }
  assert.throws(() => parse({ ...audio(), sha256: '0'.repeat(64) }), /digest/);
  assert.throws(() => parsePaulinaSpeechEvent('{"type":"audio","requestId":"test","sequence":1e999}'));
  assert.throws(() => parsePaulinaSpeechEvent('x'.repeat(8193)));
});
test('shared protocol executes without Node globals and strictly decodes browser PCM', async () => {
  const source = await readFile(new URL('./paulinaSpeechProtocol.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\b|\bBuffer\b|\bspawn\b|node:/m);
  const script = stripTypeScriptTypes(source).replace(/^export\s+/gm, '');
  const globals = { TextEncoder, atob, btoa };
  assert.equal(runInNewContext('typeof Buffer + ":" + typeof process + ":" + typeof require', globals),
    'undefined:undefined:undefined');
  for (const packet of [ready, start, audio(), phoneme, viseme, end,
    { ...ready, available: false, pcm: false, reason: 'Voice unavailable' },
    { type: 'error', requestId: null, code: 'INVALID_REQUEST', message: 'Failed' }]) {
    const serialized: unknown = runInNewContext(script + '\nJSON.stringify(parsePaulinaSpeechEvent(line))',
      { ...globals, line: JSON.stringify(packet) }, { timeout: 1000 });
    assert(typeof serialized === 'string'); assert.deepEqual(JSON.parse(serialized), packet);
  }
  const oneSample = audio(0, 0, 1);
  assert.deepEqual(Array.from(decodePaulinaAudioBase64(oneSample.bytesBase64, 1)), [1, 1]);
  assert.equal(decodePaulinaAudioBase64(audio(0, 0, 640).bytesBase64, 640).byteLength, 1280);
  for (const bad of [
    { text: 'AQF=', count: 1 }, { text: 'AQE', count: 1 }, { text: 'AQE= ', count: 1 },
    { text: 'AQE=', count: 2 }, { text: 'AQE=', count: 0 }, { text: 'AQE=', count: 641 },
  ]) assert.throws(() => decodePaulinaAudioBase64(bad.text, bad.count));
  assert.throws(() => runInNewContext(script + '\nparsePaulinaSpeechEvent(line)',
    { ...globals, line: JSON.stringify({ ...audio(), sampleCount: 319 }) }), /sample count/);
  assert.throws(() => parseBrowserEvent(JSON.stringify({ text: 'ą'.repeat(4100) })), /Malformed/);
});
test('structural parsing defers hash contents; Node and default browser Web Crypto reject tampered PCM before scheduling', async () => {
  const tampered = parseBrowserEvent(JSON.stringify({ ...audio(), sha256: '0'.repeat(64) }));
  assert(tampered.type === 'audio');
  assert.throws(() => parsePaulinaSpeechEvent(JSON.stringify(tampered)), /digest/);
  let scheduled = 0, resumed = 0;
  const player = new PcmStreamPlayer({
    nowSeconds: () => 0, resume: async () => { resumed++; },
    schedule: () => { scheduled++; return { stop: () => {} }; },
  }, { streamId: 'browser-protocol', maxChunkMs: 40, startDelayMs: 0 });
  try {
    await assert.rejects(player.enqueue({ sequence: tampered.sequence, sampleRate: tampered.sampleRate,
      pcm16: decodePaulinaAudioBase64(tampered.bytesBase64, tampered.sampleCount), sha256: tampered.sha256 }), /digest mismatch/);
    assert.equal(scheduled, 0); assert.equal(resumed, 0);
    const valid = parseBrowserEvent(JSON.stringify(audio()));
    assert(valid.type === 'audio');
    const proof = await player.enqueue({ sequence: valid.sequence, sampleRate: valid.sampleRate,
      pcm16: decodePaulinaAudioBase64(valid.bytesBase64, valid.sampleCount), sha256: valid.sha256 });
    assert.equal(proof.audioSha256, valid.sha256);
    assert.equal(scheduled, 1); assert.equal(resumed, 1);
  } finally { player.stop(); }
});
test('request ordering, sample continuity, native timing and final counters are enforced', async () => {
  for (const mode of ['wrong-id', 'no-start', 'gap', 'sequence', 'totals', 'nonmonotonic', 'oversized']) {
    const engine = new PaulinaSpeechStream({ spawnWorker: factory(mode) });
    try { await assert.rejects(engine.stream('Cześć', new AbortController().signal, async () => {})); }
    finally { engine.close(); }
  }
});
test('onEvent is awaited; one active call, cancellation isolation, fresh start and warm reuse', async () => {
  const children: ChildProcessWithoutNullStreams[] = [];
  const engine = new PaulinaSpeechStream({ spawnWorker: factory('normal', children) });
  let release!: () => void, entered!: () => void, callbacks = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = new Promise<void>(resolve => { entered = resolve; });
  const controller = new AbortController();
  try {
    const active = engine.stream('Cześć', controller.signal, async () => { callbacks++; entered(); await gate; });
    const rejected = assert.rejects(active, /canceled/);
    await first; await delay(40);
    assert.equal(callbacks, 1);
    assert(children[0].stdout.readableLength <= children[0].stdout.readableHighWaterMark + 65536);
    await assert.rejects(engine.stream('Hej', new AbortController().signal, async () => {}), /busy/);
    controller.abort(); await rejected; release(); await delay(20);
    assert.equal(callbacks, 1);
    const result = await engine.stream('Witaj', new AbortController().signal, async () => {});
    assert.equal(result.totalSamples, 320);
    await engine.stream('Ponownie', new AbortController().signal, async () => {});
    assert.equal(children.length, 2);
    assert.equal((await engine.health()).available, true);
  } finally { release(); engine.close(); }
  assert.equal((await engine.health()).available, false);
});
test('invalid text/pre-abort are lazy; deadlines, callback failures and close stop owned workers', async () => {
  const children: ChildProcessWithoutNullStreams[] = [];
  const engine = new PaulinaSpeechStream({ spawnWorker: factory('normal', children) });
  try {
    for (const text of ['', ' ', 'x'.repeat(6001)])
      await assert.rejects(engine.stream(text, new AbortController().signal, async () => {}), /characters/);
    await assert.rejects(engine.stream('Hej', AbortSignal.abort(), async () => {}));
    assert.equal(children.length, 0);
    await assert.rejects(engine.stream('Hej', new AbortController().signal, async () => { throw new Error('sink failed'); }), /sink failed/);
    await engine.stream('Hej', new AbortController().signal, async () => {});
    assert.equal(children.length, 2);
    const interrupted = engine.stream('Hej', new AbortController().signal, async () => { engine.close(); });
    await assert.rejects(interrupted, /closed|stale/);
  } finally { engine.close(); }
  const cold = new PaulinaSpeechStream({ spawnWorker: factory('no-ready'), startupTimeoutMs: 100 });
  const hung = new PaulinaSpeechStream({ spawnWorker: factory('hang'), synthesisTimeoutMs: 100 });
  try {
    assert.match((await cold.health()).reason!, /startup deadline/);
    await assert.rejects(hung.stream('Hej', new AbortController().signal, async () => {}), /synthesis deadline/);
  } finally { cold.close(); hung.close(); }
});
test('cancellation during startup cannot clear or deliver events into the replacement worker', async () => {
  const children: ChildProcessWithoutNullStreams[] = [];
  const engine = new PaulinaSpeechStream({ spawnWorker: () =>
    factory(children.length === 0 ? 'no-ready' : 'normal', children)() });
  const controller = new AbortController(); let staleEvents = 0;
  try {
    const canceled = engine.stream('Hej', controller.signal, async () => { staleEvents++; });
    const rejection = assert.rejects(canceled, /canceled/);
    controller.abort(); await rejection;
    await engine.stream('Ponownie', new AbortController().signal, async () => {});
    assert.equal(staleEvents, 0); assert.equal(children.length, 2);
  } finally { engine.close(); }
});
test('real Windows Paulina: exact PCM, native events, warm reuse and cancellation/restart', {
  skip: process.platform !== 'win32', timeout: 90000,
}, async t => {
  const engine = new PaulinaSpeechStream();
  try {
    // Use an independent installed-voice check so initialization bugs cannot masquerade as a skipped test.
    const probe = spawn(joinWindowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; try { if ($s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Name -eq 'Microsoft Paulina Desktop' -and $_.VoiceInfo.Culture.Name -eq 'pl-PL' }) { exit 0 } else { exit 2 } } finally { $s.Dispose() }"],
    { windowsHide: true, stdio: 'ignore' });
    const installed = await new Promise<number | null>((resolve, reject) => { probe.once('error', reject); probe.once('close', resolve); });
    if (installed === 2) { t.skip('Microsoft Paulina Desktop/pl-PL is not installed'); return; }
    assert.equal(installed, 0);
    async function speak(label: string) {
      let bytes = 0, audible = false, phonemes = 0, visemes = 0;
      const kinds = { boundary: 0, modifier: 0, 'native-token': 0 };
      const metrics = await engine.stream('Cześć, jestem Paulina. Miło cię słyszeć.', new AbortController().signal, async e => {
        if (e.type === 'audio') {
          const pcmBytes = Buffer.from(e.bytesBase64, 'base64');
          assert(pcmBytes.length <= 640); assert.notEqual(pcmBytes.toString('ascii', 0, 4), 'RIFF');
          bytes += pcmBytes.length; audible ||= pcmBytes.some(value => value !== 0);
        }
        if (e.type === 'phoneme') { phonemes++; kinds[e.kind]++; }
        if (e.type === 'viseme') visemes++;
      });
      assert.equal(bytes, metrics.totalSamples * 2); assert(audible && phonemes > 0 && visemes > 0);
      assert(kinds.boundary > 0 && kinds.modifier > 0 && kinds['native-token'] > 0);
      t.diagnostic(`${label}: ${JSON.stringify({ ...metrics, tokenKinds: kinds })}`); return metrics;
    }
    const cold = await speak('cold');
    assert.equal((await engine.health()).pcm, true);
    const warm = await speak('warm');
    assert.equal(warm.totalSamples, cold.totalSamples);
    assert(warm.warmupMs < cold.warmupMs);
    const controller = new AbortController(); let events = 0;
    await assert.rejects(engine.stream('To jest wypowiedź do przerwania. '.repeat(20), controller.signal, async e => {
      events++; if (e.type === 'audio') controller.abort();
    }), /canceled|abort/i);
    const stopped = events; await delay(100); assert.equal(events, stopped);
    t.diagnostic(`cancel: ${events} delivered events, no stale events`);
    await speak('after-cancel');
  } finally { engine.close(); }
});
function joinWindowsPowerShell(): string {
  return `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}
