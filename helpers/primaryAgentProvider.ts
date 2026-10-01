import type { AgentCapability, AgentMessage, AgentResult, AgentTask } from './agentProtocol.ts';

export type PrimaryAgentStatus = 'CONNECTED' | 'DISCONNECTED' | 'NOT_CONFIGURED' | 'ERROR';
export type PrimaryConnectionState = PrimaryAgentStatus;
export type AgentProviderKind = 'primary' | 'local' | 'specialist';

export interface PrimaryAgentAdapter {
  sendTask(task: AgentTask): Promise<AgentResult>;
  sendMessage(message: AgentMessage): Promise<AgentMessage>;
  stream?(taskId: string, onChunk: (chunk: string) => void): Promise<void>;
  cancel?(taskId: string): Promise<void>;
  health(): Promise<{ status: PrimaryAgentStatus; ok: boolean; message?: string }>;
  capabilities?(): Promise<AgentCapability[]>;
}

export interface AgentProviderContract {
  id: string;
  kind: AgentProviderKind;
  sendTask(task: AgentTask): Promise<AgentResult>;
  sendMessage(message: AgentMessage): Promise<AgentMessage>;
  stream(taskId: string, onChunk: (chunk: string) => void): Promise<void>;
  cancel(taskId: string): Promise<void>;
  health(): Promise<{ status: PrimaryConnectionState; ok: boolean; message?: string }>;
  capabilities(): Promise<AgentCapability[]>;
}

export interface PrimaryAgentConfig {
  id?: string;
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  mode?: 'official' | 'mock';
}

export class PrimaryAgentProvider implements AgentProviderContract {
  readonly id: string;
  readonly kind: AgentProviderKind;
  private readonly adapter?: PrimaryAgentAdapter;
  private stateOverride?: { status: 'DISCONNECTED' | 'ERROR'; message?: string };

  constructor(
    configOrId: PrimaryAgentConfig | string = {},
    adapterOrKind?: PrimaryAgentAdapter | AgentProviderKind,
    kind: AgentProviderKind = 'primary',
  ) {
    const config = typeof configOrId === 'string' ? undefined : configOrId;
    this.id = typeof configOrId === 'string' ? configOrId : configOrId.id ?? configOrId.name ?? 'primary-agent';
    this.adapter = typeof adapterOrKind === 'object' ? adapterOrKind : undefined;
    this.kind = typeof adapterOrKind === 'string' ? adapterOrKind : kind;
  }

  setDisconnected(): void {
    this.stateOverride = { status: 'DISCONNECTED' };
  }

  setError(message?: string): void {
    this.stateOverride = { status: 'ERROR', message };
  }

  private requireAdapter(): PrimaryAgentAdapter {
    if (!this.adapter) throw new Error('Primary agent is not configured. Connect an official provider bridge.');
    return this.adapter;
  }

  sendTask(task: AgentTask): Promise<AgentResult> { return this.requireAdapter().sendTask(task); }
  sendMessage(message: AgentMessage): Promise<AgentMessage> { return this.requireAdapter().sendMessage(message); }

  async stream(taskId: string, onChunk: (chunk: string) => void): Promise<void> {
    const adapter = this.requireAdapter();
    if (!adapter.stream) throw new Error('Primary agent streaming is not configured.');
    await adapter.stream(taskId, onChunk);
  }

  async cancel(taskId: string): Promise<void> {
    await this.requireAdapter().cancel?.(taskId);
  }

  async health(): Promise<{ status: PrimaryAgentStatus; ok: boolean; message?: string }> {
    if (this.stateOverride) return { ...this.stateOverride, ok: false };
    if (!this.adapter) {
      return { status: 'NOT_CONFIGURED', ok: false, message: 'Official primary-agent bridge is not configured.' };
    }
    try {
      return await this.adapter.health();
    } catch (error) {
      return {
        status: 'ERROR',
        ok: false,
        message: error instanceof Error ? error.message : 'Primary-agent health check failed',
      };
    }
  }

  async capabilities(): Promise<AgentCapability[]> {
    if (!this.adapter) return [];
    return this.adapter.capabilities?.() ?? [];
  }
}
