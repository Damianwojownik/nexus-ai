import type { CharacterIdentity } from './characterEngine.ts';
import { validateCharacterIdentity } from './characterEngine.ts';

export type LiveAvatarHealth = {
  available: boolean;
  status: 'AVAILABLE' | 'NOT_CONFIGURED' | 'DISCONNECTED' | 'ERROR';
  mode?: string;
  provider?: string;
  reason?: string;
};

export type LiveAvatarOffer = {
  type: 'answer';
  sdp: string;
};

export type LiveAvatarSession = {
  sessionId: string;
  controlUrl: string;
  iceServers: RTCIceServer[];
};

type Fetcher = typeof fetch;

function safeControlUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Live renderer omitted the session control URL');
  const url = new URL(value);
  if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Live renderer returned an unsafe control URL');
  }
  if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Non-local live control connections require WSS');
  }
  return url.href;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class SelfHostedLiveAvatarServerClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetcher: Fetcher;

  constructor(
    baseUrl = process.env.NEXUS_LIVE_AVATAR_SERVER_URL ?? '',
    token = process.env.NEXUS_LIVE_AVATAR_SERVER_TOKEN ?? '',
    fetcher: Fetcher = fetch,
  ) {
    this.baseUrl = baseUrl.trim().replace(/\/$/, '');
    this.token = token.trim();
    this.fetcher = fetcher;
  }

  configured(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.token}` };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.configured()) throw new Error('Persistent neural live avatar server is not configured');
    const url = new URL(path, `${this.baseUrl}/`);
    if (url.origin !== new URL(this.baseUrl).origin) throw new Error('Live avatar request escaped the configured server origin');
    return this.fetcher(url, {
      ...init,
      headers: { ...this.headers(), ...init.headers },
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(10000),
    });
  }

  async health(): Promise<LiveAvatarHealth> {
    if (!this.configured()) {
      return {
        available: false,
        status: 'NOT_CONFIGURED',
        reason: 'Persistent neural renderer is not configured; no 2D or video fallback is used.',
      };
    }
    try {
      const response = await this.request('/v1/live/health', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { available: false, status: 'ERROR', reason: `Live renderer health HTTP ${response.status}` };
      const body: unknown = await response.json();
      if (!object(body)) return { available: false, status: 'ERROR', reason: 'Malformed live renderer health response' };
      if (body.available !== true || body.mode !== 'persistent-neural-stream' || body.warm !== true) {
        return {
          available: false, status: 'ERROR',
          provider: typeof body.provider === 'string' ? body.provider : undefined,
          mode: typeof body.mode === 'string' ? body.mode : undefined,
          reason: typeof body.reason === 'string' ? body.reason : 'Renderer is not a warm persistent neural stream',
        };
      }
      return {
        available: true, status: 'AVAILABLE',
        provider: typeof body.provider === 'string' ? body.provider : undefined,
        mode: body.mode,
      };
    } catch (error) {
      return {
        available: false, status: 'DISCONNECTED',
        reason: error instanceof Error ? error.message : 'Live renderer health check failed',
      };
    }
  }

  async createSession(identity: CharacterIdentity): Promise<LiveAvatarSession> {
    validateCharacterIdentity(identity);
    const response = await this.request('/v1/live/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity }),
    });
    if (!response.ok) throw new Error(`Live renderer session creation HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!object(body) || typeof body.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.sessionId)) {
      throw new Error('Live renderer returned an invalid session identity');
    }
    const iceServers = body.iceServers;
    if (iceServers !== undefined && (!Array.isArray(iceServers) || iceServers.some(server =>
      !object(server) || !(typeof server.urls === 'string' || Array.isArray(server.urls))))) {
      throw new Error('Live renderer returned invalid ICE servers');
    }
    return {
      sessionId: body.sessionId,
      controlUrl: safeControlUrl(body.controlUrl),
      iceServers: (iceServers ?? []) as RTCIceServer[],
    };
  }

  async exchangeOffer(sessionId: string, sdp: string): Promise<LiveAvatarOffer> {
    this.assertSessionId(sessionId);
    if (!sdp.trim() || sdp.length > 256 * 1024) throw new Error('WebRTC offer must contain 1-262144 characters');
    const response = await this.request(`/v1/live/sessions/${encodeURIComponent(sessionId)}/offer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'offer', sdp }),
    });
    if (!response.ok) throw new Error(`Live renderer offer HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!object(body) || body.type !== 'answer' || typeof body.sdp !== 'string' || !body.sdp.trim()) {
      throw new Error('Live renderer returned an invalid WebRTC answer');
    }
    return { type: 'answer', sdp: body.sdp };
  }

  async closeSession(sessionId: string): Promise<void> {
    this.assertSessionId(sessionId);
    const response = await this.request(`/v1/live/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw new Error(`Live renderer session close HTTP ${response.status}`);
  }

  private assertSessionId(sessionId: string): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Invalid live renderer session ID');
  }
}
