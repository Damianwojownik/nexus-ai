export const PAULINA_PCM_FORMAT = Object.freeze({
  encoding: 'PCM16LE', sampleRate: 16000, channels: 1, bitsPerSample: 16,
} as const);
export const PAULINA_IDENTITY = Object.freeze({
  voice: 'Microsoft Paulina Desktop', language: 'pl-PL', cost: 0, device: 'cpu',
} as const);
export const PAULINA_MAX_PACKET_BYTES = 8192;
const MAX_SAMPLES = 28_800_000;
type Pcm = typeof PAULINA_PCM_FORMAT;
type Identity = typeof PAULINA_IDENTITY;
type Emphasis = 0 | 1 | 2; // Native zero is unnamed; 1 = Stressed, 2 = Emphasized.
type NativeTiming = { audioPositionMs: number; durationMs: number; emphasis: Emphasis };
export type PaulinaReadyEvent = Pcm & Identity & {
  type: 'ready'; available: boolean; pcm: boolean; reason: string | null;
};
export type PaulinaStartEvent = Pcm & Identity & { type: 'start'; requestId: string };
export type PaulinaAudioEvent = Pcm & {
  type: 'audio'; requestId: string; sequence: number; startSample: number; sampleCount: number;
  bytesBase64: string; sha256: string;
};
export type PaulinaPhonemeEvent = NativeTiming & {
  type: 'phoneme'; requestId: string; source: 'System.Speech.PhonemeReached'; symbol: string; nextSymbol: string;
  kind: 'native-token' | 'modifier' | 'boundary';
};
export type PaulinaVisemeEvent = NativeTiming & {
  type: 'viseme'; requestId: string; source: 'System.Speech.VisemeReached'; viseme: number; nextViseme: number;
};
export type PaulinaEndEvent = {
  type: 'end'; requestId: string; totalSamples: number; chunks: number; phonemes: number; visemes: number;
  audioDurationMs: number; synthesisMs: number; firstPcmMs: number;
};
export type PaulinaErrorEvent = {
  type: 'error'; requestId: string | null; code: 'INVALID_REQUEST' | 'SYNTHESIS_FAILED'; message: string;
};
export type PaulinaSpeechEvent = PaulinaReadyEvent | PaulinaStartEvent | PaulinaAudioEvent
  | PaulinaPhonemeEvent | PaulinaVisemeEvent | PaulinaEndEvent | PaulinaErrorEvent;
export type PaulinaSpeechHealth = Omit<PaulinaReadyEvent, 'type'>;
/** Native times include pipe backpressure; observed first-PCM times distinguish cold startup from warm synthesis. */
export type PaulinaStreamMetrics = PaulinaEndEvent & {
  warmupMs: number; firstPcmIncludingWarmupMs: number; firstPcmAfterWarmupMs: number; elapsedMs: number;
};
function requirePacket(ok: unknown, message = 'Malformed Paulina packet'): asserts ok {
  if (!ok) throw new Error(message);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const integer = (n: unknown, min = 0, max = MAX_SAMPLES): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
const milliseconds = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_SAMPLES / 16;
const string = (s: unknown, min = 0, max = 128): s is string =>
  typeof s === 'string' && s.length >= min && s.length <= max;
function shape(p: Record<string, unknown>, fields: string[]) {
  requirePacket(Object.keys(p).length === fields.length && fields.every(k => Object.hasOwn(p, k)));
}
function format(p: Record<string, unknown>) {
  requirePacket(Object.entries(PAULINA_PCM_FORMAT).every(([key, value]) => p[key] === value), 'Invalid Paulina PCM format');
}
function identity(p: Record<string, unknown>) {
  requirePacket(Object.entries(PAULINA_IDENTITY).every(([key, value]) => p[key] === value), 'Invalid Paulina voice/scope');
}
function requestId(p: Record<string, unknown>): string {
  requirePacket(string(p.requestId, 1, 80) && /^[A-Za-z0-9_-]+$/.test(p.requestId), 'Invalid Paulina requestId');
  return p.requestId;
}
function timing(p: Record<string, unknown>): NativeTiming {
  requirePacket(milliseconds(p.audioPositionMs) && milliseconds(p.durationMs)
    && (p.emphasis === 0 || p.emphasis === 1 || p.emphasis === 2));
  return { audioPositionMs: p.audioPositionMs, durationMs: p.durationMs, emphasis: p.emphasis };
}
/** Decode canonical base64 into complete signed PCM16LE samples. Digest verification belongs to the consuming runtime. */
export function decodePaulinaAudioBase64(bytesBase64: string, sampleCount: number): Uint8Array {
  requirePacket(string(bytesBase64, 4, 1708) && integer(sampleCount, 1, 640)
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bytesBase64),
  'Invalid Paulina PCM bytes/sample count');
  const binary = atob(bytesBase64);
  requirePacket(binary.length === sampleCount * 2 && btoa(binary) === bytesBase64,
    'Invalid Paulina PCM bytes/sample count');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
/** Browser-safe structural parser only. Hash contents must be verified before forwarding or scheduling PCM.
 * Native tokens are preserved verbatim, not promoted to clinical phoneme segmentation.
 */
export function parsePaulinaSpeechEvent(line: string): PaulinaSpeechEvent {
  requirePacket(typeof line === 'string' && line.length <= PAULINA_MAX_PACKET_BYTES
    && new TextEncoder().encode(line).byteLength <= PAULINA_MAX_PACKET_BYTES);
  const p: unknown = JSON.parse(line);
  requirePacket(record(p));
  const base = ['type', 'requestId'];
  switch (p.type) {
    case 'ready': {
      shape(p, ['type', ...Object.keys(PAULINA_PCM_FORMAT), ...Object.keys(PAULINA_IDENTITY), 'available', 'pcm', 'reason']);
      format(p); identity(p);
      requirePacket(typeof p.available === 'boolean' && p.pcm === p.available);
      if (p.available) requirePacket(p.reason === null); else requirePacket(string(p.reason, 1, 240));
      return { type: 'ready', ...PAULINA_PCM_FORMAT, ...PAULINA_IDENTITY,
        available: p.available, pcm: p.available, reason: p.reason };
    }
    case 'start':
      shape(p, [...base, ...Object.keys(PAULINA_PCM_FORMAT), ...Object.keys(PAULINA_IDENTITY)]);
      format(p); identity(p);
      return { type: 'start', requestId: requestId(p), ...PAULINA_PCM_FORMAT, ...PAULINA_IDENTITY };
    case 'audio':
      shape(p, [...base, ...Object.keys(PAULINA_PCM_FORMAT), 'sequence', 'startSample', 'sampleCount', 'bytesBase64', 'sha256']);
      format(p);
      requirePacket(integer(p.sequence) && integer(p.startSample) && integer(p.sampleCount, 1, 640)
        && p.startSample + p.sampleCount <= MAX_SAMPLES && string(p.bytesBase64, 4, 1708)
        && string(p.sha256, 64, 64) && /^[a-f0-9]{64}$/.test(p.sha256));
      decodePaulinaAudioBase64(p.bytesBase64, p.sampleCount);
      return { type: 'audio', requestId: requestId(p), ...PAULINA_PCM_FORMAT,
        sequence: p.sequence, startSample: p.startSample, sampleCount: p.sampleCount,
        bytesBase64: p.bytesBase64, sha256: p.sha256 };
    case 'phoneme':
    case 'viseme': {
      shape(p, [...base, 'source', 'audioPositionMs', 'durationMs', 'emphasis',
        ...(p.type === 'phoneme' ? ['symbol', 'nextSymbol', 'kind'] : ['viseme', 'nextViseme'])]);
      const nativeTiming = timing(p), id = requestId(p);
      if (p.type === 'phoneme') {
        requirePacket(p.source === 'System.Speech.PhonemeReached' && string(p.symbol, 1) && string(p.nextSymbol));
        const kind = p.symbol === '\u0004' ? 'boundary'
          : /^[\p{M}\p{Lm}]+$/u.test(p.symbol) ? 'modifier' : 'native-token';
        requirePacket(p.kind === kind, 'Invalid native token provenance');
        return { type: 'phoneme', requestId: id, source: 'System.Speech.PhonemeReached',
          symbol: p.symbol, nextSymbol: p.nextSymbol, kind, ...nativeTiming };
      }
      requirePacket(p.source === 'System.Speech.VisemeReached'
        && integer(p.viseme, 0, 21) && integer(p.nextViseme, 0, 21));
      return { type: 'viseme', requestId: id, source: 'System.Speech.VisemeReached',
        viseme: p.viseme, nextViseme: p.nextViseme, ...nativeTiming };
    }
    case 'end':
      shape(p, [...base, 'totalSamples', 'chunks', 'phonemes', 'visemes', 'audioDurationMs', 'synthesisMs', 'firstPcmMs']);
      requirePacket(integer(p.totalSamples, 1) && integer(p.chunks, 1) && integer(p.phonemes) && integer(p.visemes)
        && milliseconds(p.audioDurationMs) && p.audioDurationMs === p.totalSamples / 16
        && milliseconds(p.synthesisMs) && milliseconds(p.firstPcmMs) && p.firstPcmMs <= p.synthesisMs);
      return { type: 'end', requestId: requestId(p), totalSamples: p.totalSamples, chunks: p.chunks,
        phonemes: p.phonemes, visemes: p.visemes, audioDurationMs: p.audioDurationMs,
        synthesisMs: p.synthesisMs, firstPcmMs: p.firstPcmMs };
    case 'error':
      shape(p, [...base, 'code', 'message']);
      requirePacket((p.code === 'INVALID_REQUEST' || p.code === 'SYNTHESIS_FAILED') && string(p.message, 1, 240));
      return { type: 'error', requestId: p.requestId === null ? null : requestId(p), code: p.code, message: p.message };
    default: throw new Error('Unknown Paulina event');
  }
}
