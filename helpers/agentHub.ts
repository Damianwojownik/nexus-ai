import { createAgentEvent } from './agentProtocol.ts';
import type {
  AgentCapability,
  AgentEvent,
  AgentKind,
  AgentPresence,
  AgentPresenceStatus,
  AgentResult,
  AgentTask,
  AgentTaskStatus,
} from './agentProtocol.ts';

export interface AgentHubOptions {
  agentId: string;
  kind: AgentKind;
  capabilities: string[];
  presence?: AgentPresenceStatus;
}

export class AgentHub {
  private readonly tasks = new Map<string, AgentTask>();
  private readonly eventLog: AgentEvent[] = [];
  private readonly agentId: string;
  private readonly kind: AgentKind;
  private readonly capabilities: string[];
  private presence: AgentPresenceStatus;

  constructor(options: AgentHubOptions) {
    this.agentId = options.agentId;
    this.kind = options.kind;
    this.capabilities = options.capabilities;
    this.presence = options.presence ?? 'online';
  }

  getPresence(): AgentPresence {
    return {
      agentId: this.agentId,
      status: this.presence,
      capabilities: this.capabilities,
      heartbeatAt: new Date().toISOString(),
      connected: this.presence !== 'offline',
    };
  }

  heartbeat(): AgentPresence {
    this.presence = 'online';
    return this.getPresence();
  }

  setPresence(status: AgentPresenceStatus) {
    this.presence = status;
    this.logEvent('IDLE', this.agentId, `Presence changed to ${status}`);
  }

  logEvent(type: AgentEvent['type'], agentId: string, message: string, taskId?: string, metadata?: Record<string, unknown>) {
    const event = createAgentEvent(type, agentId, message, taskId, metadata);
    this.eventLog.unshift(event);
    return event;
  }

  getEventLog(limit = 20): AgentEvent[] {
    return this.eventLog.slice(0, limit);
  }

  submitTask(task: AgentTask): AgentTask {
    this.tasks.set(task.id, task);
    this.logEvent('EXECUTING', task.assignedTo, `Task accepted: ${task.goal}`, task.id, { scope: task.scope });
    return task;
  }

  getTask(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(status?: AgentTaskStatus): AgentTask[] {
    const tasks = [...this.tasks.values()];
    return status ? tasks.filter((task) => task.status === status) : tasks;
  }

  updateTask(taskId: string, patch: Partial<AgentTask>): AgentTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    const next = {
      ...task,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, next);
    return next;
  }

  leaseTask(taskId: string, owner: string, ttlMs = 300000): AgentTask | undefined {
    const task = this.getTask(taskId);
    if (!task) return undefined;

    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const next = this.updateTask(taskId, {
      assignedTo: owner,
      lease: { owner, expiresAt },
      status: 'WORKING',
    });
    this.logEvent('EXECUTING', owner, `Task leased: ${task.goal}`, taskId, { expiresAt });
    return next;
  }

  transferTask(taskId: string, nextOwner: string): AgentTask | undefined {
    const task = this.getTask(taskId);
    if (!task) return undefined;

    this.logEvent('EXECUTING', nextOwner, `Task reassigned from ${task.assignedTo} to ${nextOwner}`, taskId);
    return this.updateTask(taskId, {
      assignedTo: nextOwner,
      status: 'TODO',
      lease: null,
    });
  }

  completeTask(taskId: string, result: AgentResult): AgentTask | undefined {
    const task = this.getTask(taskId);
    if (!task) return undefined;

    const next = this.updateTask(taskId, {
      status: 'DONE',
      result,
      error: undefined,
      lease: null,
    });
    this.logEvent('SPEAKING', task.assignedTo, `Task complete: ${result.summary}`, taskId, { result });
    return next;
  }

  failTask(taskId: string, error: string): AgentTask | undefined {
    const task = this.getTask(taskId);
    if (!task) return undefined;

    const next = this.updateTask(taskId, {
      status: 'BLOCKED',
      error,
    });
    this.logEvent('ERROR', task.assignedTo, `Task blocked: ${error}`, taskId, { error });
    return next;
  }

  cancelTask(taskId: string): AgentTask | undefined {
    const task = this.getTask(taskId);
    if (!task) return undefined;

    const next = this.updateTask(taskId, {
      status: 'BLOCKED',
      error: 'Cancelled by owner',
      lease: null,
    });
    this.logEvent('INTERRUPTED', this.agentId, `Task cancelled: ${task.goal}`, taskId);
    return next;
  }

  capabilities(): AgentCapability[] {
    return this.capabilities.map((name) => ({
      name,
      description: `Agent capability: ${name}`,
      supported: true,
    }));
  }
}
