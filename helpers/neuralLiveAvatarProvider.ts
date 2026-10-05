import { validateCharacterIdentity } from './characterEngine.ts';
import type { CharacterIdentity } from './characterEngine.ts';
import type { VisemeCue } from './visemeEngine.ts';
import type { LiveAvatarHealth, LiveAvatarSession } from './selfHostedLiveAvatarServer.ts';
import type { CharacterIdentity as AvatarIdentity } from './characterEngine.ts';

export type NeuralAvatarState =
  | 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING' | 'EXECUTING' | 'INTERRUPTED' | 'ERROR';
export type NeuralAvatarEmotion =
  | 'neutral' | 'warm_smile' | 'happy' | 'concerned' | 'focused' | 'thinking';

export interface NeuralLiveSession {
  readonly identity: Readonly<CharacterIdentity>;
  readonly video: MediaStream;
  setState(state: NeuralAvatarState, ptsMs?: number, emotion?: NeuralAvatarEmotion): void;
  pushAudioChunk(streamId: string, sequence: number, pcm16: Uint8Array, ptsMs: number): void;
  pushViseme(streamId: string, cue: VisemeCue): void;
  interrupt(ptsMs: number): void;
  close(): Promise<void>;
}

export interface NeuralLiveTransport {
  createPeer(configuration: RTCConfiguration): RTCPeerConnection;
  createWebSocket(url: string): WebSocket;
}

export interface NeuralLiveServerApi {
  health(): Promise<LiveAvatarHealth>;
  createSession(identity: AvatarIdentity): Promise<LiveAvatarSession>;
  exchangeOffer(sessionId: string, sdp: string): Promise<{ type: 'answer'; sdp: string }>;
  closeSession(sessionId: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLiveHealthStatus(value: unknown): value is LiveAvatarHealth['status'] {
  return value === 'AVAILABLE' || value === 'NOT_CONFIGURED' || value === 'DISCONNECTED' || value === 'ERROR';
}

export class AgentHubLiveAvatarClient implements NeuralLiveServerApi {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(baseUrl: string, fetcher: typeof fetch = fetch) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) {
      throw new Error('Neural live avatar must use the local credential-free Agent Hub');
    }
    this.baseUrl = url.href.replace(/\/$/, '');
    this.fetcher = fetcher.bind(globalThis);
  }

  async health(): Promise<LiveAvatarHealth> {
    try {
      const response = await this.fetcher(`${this.baseUrl}/api/avatar/live/health`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { available: false, status: 'ERROR', reason: `Agent Hub live avatar health HTTP ${response.status}` };
      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body.available !== 'boolean' || !isLiveHealthStatus(body.status)) {
        return { available: false, status: 'ERROR', reason: 'Agent Hub returned malformed live avatar health' };
      }
      return {
        available: body.available,
        status: body.status,
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        ...(typeof body.mode === 'string' ? { mode: body.mode } : {}),
        ...(typeof body.provider === 'string' ? { provider: body.provider } : {}),
      };
    } catch (error) {
      return { available: false, status: 'DISCONNECTED', reason: error instanceof Error ? error.message : 'Agent Hub is unreachable' };
    }
  }

  async createSession(identity: AvatarIdentity): Promise<LiveAvatarSession> {
    const response = await this.fetcher(`${this.baseUrl}/api/avatar/live/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity }), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Live avatar session HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.sessionId)
      || typeof body.controlUrl !== 'string' || !Array.isArray(body.iceServers)) {
      throw new Error('Agent Hub returned a malformed live avatar session');
    }
    const iceServers: RTCIceServer[] = [];
    for (const value of body.iceServers) {
      if (!isRecord(value)) throw new Error('Agent Hub returned an invalid ICE server');
      const urls = typeof value.urls === 'string' ? value.urls
        : Array.isArray(value.urls) && value.urls.every((url): url is string => typeof url === 'string') ? value.urls : undefined;
      if (!urls || (value.username !== undefined && typeof value.username !== 'string')
        || (value.credential !== undefined && typeof value.credential !== 'string')) {
        throw new Error('Agent Hub returned an invalid ICE server');
      }
      iceServers.push({
        urls,
        ...(typeof value.username === 'string' ? { username: value.username } : {}),
        ...(typeof value.credential === 'string' ? { credential: value.credential } : {}),
      });
    }
    return {
      sessionId: body.sessionId,
      controlUrl: body.controlUrl,
      iceServers,
    };
  }

  async exchangeOffer(sessionId: string, sdp: string): Promise<{ type: 'answer'; sdp: string }> {
    const response = await this.fetcher(`${this.baseUrl}/api/avatar/live/sessions/${encodeURIComponent(sessionId)}/offer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'offer', sdp }), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Live avatar WebRTC offer HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!isRecord(body) || body.type !== 'answer' || typeof body.sdp !== 'string' || !body.sdp.trim()) {
      throw new Error('Agent Hub returned a malformed live WebRTC answer');
    }
    return { type: 'answer', sdp: body.sdp };
  }

  async closeSession(sessionId: string): Promise<void> {
    const response = await this.fetcher(`${this.baseUrl}/api/avatar/live/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok && response.status !== 404) throw new Error(`Live avatar close HTTP ${response.status}`);
  }
}

const browserTransport: NeuralLiveTransport = {
  createPeer: configuration => new RTCPeerConnection(configuration),
  createWebSocket: url => new WebSocket(url),
};

function assertPts(ptsMs: number): void {
  if (!Number.isFinite(ptsMs) || ptsMs < 0) throw new Error('Neural live PTS must be finite and nonnegative');
}

function controlWebSocketUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Neural live control requires WSS except for loopback development');
  }
  return url.href;
}

function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) { resolve(); return; }
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('Neural live control connection timed out'));
    }, timeoutMs);
    const opened = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Neural live control connection failed')); };
    const cleanup = () => {
      window.clearTimeout(timer);
      socket.removeEventListener('open', opened);
      socket.removeEventListener('error', failed);
    };
    socket.addEventListener('open', opened, { once: true });
    socket.addEventListener('error', failed, { once: true });
  });
}

function waitForIce(peer: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('Neural live ICE gathering timed out'));
    }, timeoutMs);
    const changed = () => {
      if (peer.iceGatheringState !== 'complete') return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', changed);
    };
    peer.addEventListener('icegatheringstatechange', changed);
  });
}

export function encodeLiveAudioPacket(input: {
  streamId: string;
  sequence: number;
  pcm16: Uint8Array;
  ptsMs: number;
}): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.streamId)) throw new Error('Invalid live audio stream ID');
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw new Error('Invalid live audio sequence');
  if (!input.pcm16.length || input.pcm16.length % 2) throw new Error('Live PCM16LE chunks must contain complete samples');
  assertPts(input.ptsMs);
  const header = new TextEncoder().encode(JSON.stringify({
    type: 'AUDIO', streamId: input.streamId, sequence: input.sequence,
    ptsMs: input.ptsMs, encoding: 'PCM16LE', sampleRate: 16000, channels: 1,
    byteLength: input.pcm16.length,
  }));
  if (header.length > 4096) throw new Error('Live audio packet header is too large');
  const packet = new Uint8Array(4 + header.length + input.pcm16.length);
  new DataView(packet.buffer).setUint32(0, header.length, false);
  packet.set(header, 4);
  packet.set(input.pcm16, 4 + header.length);
  return packet.buffer;
}

export class NeuralLiveAvatarProvider {
  private readonly server: NeuralLiveServerApi;
  private readonly transport: NeuralLiveTransport;

  constructor(
    server: NeuralLiveServerApi,
    transport: NeuralLiveTransport = browserTransport,
  ) {
    this.server = server;
    this.transport = transport;
  }

  checkHealth(): Promise<LiveAvatarHealth> {
    return this.server.health();
  }

  async startSession(
    identity: CharacterIdentity,
    onVideo: (stream: MediaStream) => void,
  ): Promise<NeuralLiveSession> {
    validateCharacterIdentity(identity);
    const health = await this.checkHealth();
    if (!health.available) throw new Error(health.reason ?? 'Live avatar unavailable');
    const serverSession = await this.server.createSession(identity);
    const peer = this.transport.createPeer({ iceServers: serverSession.iceServers });
    let control: WebSocket | undefined;
    let closed = false;
    let latestPtsMs = 0;
    let currentStreamId: string | undefined;
    const sequences = new Map<string, number>();
    const lastPts = new Map<string, number>();
    const audio = peer.createDataChannel('nexus-live-audio', { ordered: true });
    audio.binaryType = 'arraybuffer';
    peer.addTransceiver('video', { direction: 'recvonly' });
    peer.addEventListener('track', event => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      onVideo(stream);
    });

    const sendControl = (message: Record<string, unknown>) => {
      if (!control || control.readyState !== WebSocket.OPEN) throw new Error('Neural live control is not connected');
      control.send(JSON.stringify({ ...message, ptsMs: latestPtsMs }));
    };

    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIce(peer, 10000);
      if (!peer.localDescription?.sdp) throw new Error('WebRTC produced an empty live offer');
      const answer = await this.server.exchangeOffer(serverSession.sessionId, peer.localDescription.sdp);
      await peer.setRemoteDescription({ type: answer.type, sdp: answer.sdp });
      control = this.transport.createWebSocket(controlWebSocketUrl(serverSession.controlUrl));
      await waitForOpen(control, 10000);
      await new Promise<void>((resolve, reject) => {
        if (audio.readyState === 'open') { resolve(); return; }
        const timer = window.setTimeout(() => { cleanup(); reject(new Error('Neural live audio channel timed out')); }, 10000);
        const opened = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('Neural live audio channel failed')); };
        const cleanup = () => {
          window.clearTimeout(timer);
          audio.removeEventListener('open', opened);
          audio.removeEventListener('error', failed);
        };
        audio.addEventListener('open', opened, { once: true });
        audio.addEventListener('error', failed, { once: true });
      });
      sendControl({ type: 'STATE', state: 'IDLE', emotion: 'neutral' });
    } catch (error) {
      closed = true;
      control?.close();
      peer.close();
      await this.server.closeSession(serverSession.sessionId);
      throw error;
    }

    return {
      identity: Object.freeze({ ...identity }),
      get video() {
        const track = peer.getReceivers().find(receiver => receiver.track.kind === 'video')?.track;
        if (!track) throw new Error('Neural live video track has not arrived');
        return new MediaStream([track]);
      },
      setState: (state, ptsMs = latestPtsMs, emotion = 'neutral') => {
        if (closed) throw new Error('Neural live session is closed');
        assertPts(ptsMs);
        latestPtsMs = ptsMs;
        sendControl({ type: 'STATE', state, emotion });
      },
      pushAudioChunk: (streamId, sequence, pcm16, ptsMs) => {
        if (closed || audio.readyState !== 'open') throw new Error('Neural live audio channel is unavailable');
        assertPts(ptsMs);
        const expected = sequences.get(streamId) ?? 0;
        const previousPts = lastPts.get(streamId) ?? -1;
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(streamId) || sequence !== expected || ptsMs < previousPts) {
          throw new Error('Neural live PCM sequence/PTS is invalid');
        }
        if (currentStreamId !== streamId) {
          currentStreamId = streamId;
          latestPtsMs = ptsMs;
        }
        audio.send(encodeLiveAudioPacket({ streamId, sequence, pcm16, ptsMs }));
        sequences.set(streamId, sequence + 1);
        lastPts.set(streamId, ptsMs);
        latestPtsMs = ptsMs;
      },
      pushViseme: (streamId, cue) => {
        if (closed) throw new Error('Neural live session is closed');
        assertPts(cue.startMs);
        assertPts(cue.endMs);
        if (cue.endMs <= cue.startMs || cue.intensity < 0 || cue.intensity > 1) throw new Error('Neural live viseme cue is invalid');
        if (currentStreamId !== streamId) throw new Error('Viseme cue does not belong to the active audio stream');
        latestPtsMs = cue.startMs;
        sendControl({ type: 'VISEME', streamId, cue });
      },
      interrupt: ptsMs => {
        if (closed) return;
        assertPts(ptsMs);
        latestPtsMs = ptsMs;
        sendControl({ type: 'INTERRUPT', state: 'INTERRUPTED' });
      },
      close: async () => {
        if (closed) return;
        closed = true;
        if (control?.readyState === WebSocket.OPEN) control.send(JSON.stringify({ type: 'CLOSE', ptsMs: latestPtsMs }));
        control?.close();
        peer.close();
        await this.server.closeSession(serverSession.sessionId);
      },
    };
  }
}
