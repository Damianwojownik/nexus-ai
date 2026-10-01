import type { AgentCapability, AgentMessage, AgentResult, AgentTask } from './agentProtocol.ts';

export type PrimaryAgentStatus = 'CONNECTED' | 'DISCONNECTED' | 'NOT_CONFIGURED' | 'ERROR';

export interface PrimaryAgentAdapter {
  sendTask(task: AgentTask): Promise<AgentResult>;
  sendMessage(message: AgentMessage): Promise<AgentMessage>;
  stream?(taskId: string, onChunk: (chunk: string) => void): Promise<void>;
  cancel?(taskId: string): Promise<void>;
  health(): Promise<{ status: PrimaryAgentStatus; ok: boolean; message?: string }>;
  capabilities?(): Promise<AgentCapability[]>;
}

export class PrimaryAgentProvider {
  readonly id: string;
  readonly kind = 'primary' as const;

  constructor(id = 'primary-agent', private readonly adapter?: PrimaryAgentAdapter) {
    this.id = id;
  }

  private requireAdapter(): PrimaryAgentAdapter {
    if (!this.adapter) throw new Error('Primary agent is not configured. Connect an official provider bridge.');
    return this.adapter;
  }

  sendTask(task: AgentTask) { return this.requireAdapter().sendTask(task); }
  sendMessage(message: AgentMessage) { return this.requireAdapter().sendMessage(message); }

  async stream(taskId: string, onChunk: (chunk: string) => void) {
    const adapter = this.requireAdapter();
    if (!adapter.stream) throw new Error('Primary agent streaming is not configured.');
    await adapter.stream(taskId, onChunk);
  }

  async cancel(taskId: string) {
    await this.requireAdapter().cancel?.(taskId);
  }

  async health(): Promise<{ status: PrimaryAgentStatus; ok: boolean; message?: string }> {
    if (!this.adapter) return { status: 'NOT_CONFIGURED', ok: false, message: 'Official primary-agent bridge is not configured.' };
    try {
      return await this.adapter.health();
    } catch (error: any) {
      return { status: 'ERROR', ok: false, message: error?.message || 'Primary-agent health check failed' };
    }
  }

  async capabilities(): Promise<AgentCapability[]> {
    if (!this.adapter) return [];
    return this.adapter.capabilities?.() ?? [];
  }
}
