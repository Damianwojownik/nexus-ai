import type { AgentCapability, AgentMessage, AgentResult, AgentTask } from './agentProtocol.ts';

export interface AgentProviderContract {
  id: string;
  kind: 'primary' | 'local' | 'specialist';
  sendTask(task: AgentTask): Promise<AgentResult>;
  sendMessage(message: AgentMessage): Promise<AgentMessage>;
  stream(taskId: string, onChunk: (chunk: string) => void): Promise<void>;
  cancel(taskId: string): Promise<void>;
  health(): Promise<{ status: 'online' | 'offline'; ok: boolean; message?: string }>;
  capabilities(): Promise<AgentCapability[]>;
}

export class PrimaryAgentProvider implements AgentProviderContract {
  readonly id: string;
  readonly kind: 'primary' | 'local' | 'specialist';

  constructor(id = 'primary-agent', kind: 'primary' | 'local' | 'specialist' = 'primary') {
    this.id = id;
    this.kind = kind;
  }

  async sendTask(task: AgentTask): Promise<AgentResult> {
    return {
      status: 'SUCCESS',
      summary: `Task ${task.id} accepted by ${this.id}`,
      payload: { task },
    };
  }

  async sendMessage(message: AgentMessage): Promise<AgentMessage> {
    return message;
  }

  async stream(taskId: string, onChunk: (chunk: string) => void): Promise<void> {
    onChunk(`Task ${taskId} is ready for streaming.`);
  }

  async cancel(taskId: string): Promise<void> {
    void taskId;
  }

  async health(): Promise<{ status: 'online' | 'offline'; ok: boolean; message?: string }> {
    return { status: 'online', ok: true, message: `${this.id} is ready` };
  }

  async capabilities(): Promise<AgentCapability[]> {
    return [
      { name: 'sendTask', description: 'Dispatch a work item to the primary provider', supported: true },
      { name: 'sendMessage', description: 'Send a standard agent message', supported: true },
      { name: 'stream', description: 'Stream updates from the provider', supported: true },
    ];
  }
}
