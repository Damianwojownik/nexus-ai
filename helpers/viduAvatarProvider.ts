import type { AvatarHealth, AvatarProvider, AvatarState } from './avatarProvider.ts';

export type ViduSession = {
  liveId: string;
  clientSecret: string;
  traceId?: string;
  status?: string;
};

export type ViduAvatarOptions = {
  wsBaseUrl: string;
  session: ViduSession;
  connId?: string;
  initRetryMs?: number;
};

type WsSignal = {
  type: number;
  live_id?: string;
  conn_id?: string;
  seq_id?: number;
  payload?: Record<string, any>;
};

export class ViduAvatarProvider implements AvatarProvider {
  readonly id = 'vidu-s2';
  private ws?: WebSocket;
  private seq = 0;
  private ready = false;
  private connecting?: Promise<void>;
  private resolveInit?: () => void;
  private rejectInit?: (error: Error) => void;
  private readonly connId: string;
  private healthState: AvatarHealth = { status: 'DISCONNECTED', ok: false };

  constructor(private readonly options: ViduAvatarOptions) {
    this.connId = options.connId || `nexus-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async connect(): Promise<void> {
    if (this.ready) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      this.resolveInit = resolve;
      this.rejectInit = reject;
      const { liveId, clientSecret } = this.options.session;
      const base = this.options.wsBaseUrl.replace(/\/$/, '');
      const url = `${base}/live/v1/external-lives/${encodeURIComponent(liveId)}/stream?conn_id=${encodeURIComponent(this.connId)}&client_secret=${encodeURIComponent(clientSecret)}`;

      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = () => this.sendConnInit();
      this.ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        try { this.handleSignal(JSON.parse(event.data)); }
        catch { this.healthState = { status: 'ERROR', ok: false, message: 'Invalid Vidu WebSocket signal' }; }
      };
      this.ws.onerror = () => {
        const error = new Error('Vidu WebSocket connection failed');
        this.healthState = { status: 'ERROR', ok: false, message: error.message };
        this.rejectInit?.(error);
      };
      this.ws.onclose = () => {
        this.ready = false;
        this.connecting = undefined;
        this.healthState = { status: 'DISCONNECTED', ok: false };
      };
    });

    return this.connecting;
  }

  private sendConnInit() {
    this.sendSignal(1, { conn_init: { version: 1 } }, true);
  }

  private handleSignal(signal: WsSignal) {
    if (signal.type === 2) {
      const ack = signal.payload?.conn_init_ack;
      if (ack?.success) {
        this.ready = true;
        this.healthState = { status: 'CONNECTED', ok: true };
        this.resolveInit?.();
        return;
      }
      if (ack?.error_code === 'NOT_READY') {
        setTimeout(() => this.sendConnInit(), this.options.initRetryMs ?? 800);
        return;
      }
      const error = new Error(`Vidu init failed: ${ack?.error_code || 'UNKNOWN'} ${ack?.error_msg || ''}`.trim());
      this.healthState = { status: 'ERROR', ok: false, message: error.message };
      this.rejectInit?.(error);
      if (ack?.error_code === 'LIVE_ENDED' || ack?.error_code === 'LIVE_CONN_INIT_FAILED') this.ws?.close();
      return;
    }

    if (signal.type === 6) {
      this.ready = false;
      this.healthState = { status: 'DISCONNECTED', ok: false, message: signal.payload?.hangup?.hangup_reason || 'Vidu forced hangup' };
      this.ws?.close();
    }
  }

  private sendSignal(type: number, payload: Record<string, any>, beforeReady = false) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Vidu WebSocket is not open');
    if (!beforeReady && !this.ready) throw new Error('Vidu avatar is not initialized');
    this.ws.send(JSON.stringify({
      type,
      live_id: this.options.session.liveId,
      conn_id: this.connId,
      seq_id: ++this.seq,
      payload,
    }));
  }

  async disconnect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.ready) {
      this.sendSignal(5, { hangup: { hangup_reason: 'client_hangup' } });
    }
    this.ws?.close();
    this.ready = false;
    this.connecting = undefined;
  }

  async health(): Promise<AvatarHealth> { return this.healthState; }

  async setState(state: AvatarState): Promise<void> {
    if (!this.ready) return;
    if (state === 'INTERRUPTED') await this.interrupt();
  }

  async sendInputTranscript(text: string): Promise<void> {
    if (!text.trim()) return;
    this.sendSignal(9, { text_msg: { msg_id: crypto.randomUUID(), content: text, timestamp: Date.now() } });
  }

  async sendOutputTranscript(text: string): Promise<void> {
    if (!text.trim()) return;
    this.sendSignal(10, { text_msg: { msg_id: crypto.randomUUID(), content: text, timestamp: Date.now() } });
  }

  async sendAudio(pcmS16le24kMono: ArrayBuffer): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready) throw new Error('Vidu avatar is not ready for audio');
    this.ws.send(pcmS16le24kMono);
  }

  async interrupt(): Promise<void> {
    if (this.ready) this.sendSignal(7, {});
  }
}
