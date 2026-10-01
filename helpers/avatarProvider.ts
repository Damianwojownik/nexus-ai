export type AvatarState = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING' | 'EXECUTING' | 'INTERRUPTED' | 'ERROR';

export type AvatarHealth = {
  status: 'CONNECTED' | 'DISCONNECTED' | 'NOT_CONFIGURED' | 'ERROR';
  ok: boolean;
  message?: string;
};

export interface AvatarProvider {
  readonly id: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  health(): Promise<AvatarHealth>;
  setState(state: AvatarState, metadata?: Record<string, unknown>): Promise<void>;
  sendInputTranscript(text: string): Promise<void>;
  sendOutputTranscript(text: string): Promise<void>;
  sendAudio(pcmS16le24kMono: ArrayBuffer): Promise<void>;
  interrupt(): Promise<void>;
}

export class LocalAvatarProvider implements AvatarProvider {
  readonly id = 'local-avatar';
  private connected = false;

  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  async health(): Promise<AvatarHealth> {
    return { status: this.connected ? 'CONNECTED' : 'DISCONNECTED', ok: this.connected };
  }
  async setState() {}
  async sendInputTranscript() {}
  async sendOutputTranscript() {}
  async sendAudio() {}
  async interrupt() {}
}
