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

export interface AgentRegistration {
  agentId: string;
  kind: AgentKind;
  capabilities: string[];
  presence?: AgentPresenceStatus;
}

export interface AgentHubOptions {
  stateFilePath?: string;
  presenceTimeoutMs?: number;
}

export class AgentHub {
  private readonly tasks = new Map<string, AgentTask>();
  private readonly eventLog: AgentEvent[] = [];
  private readonly agents = new Map<string, AgentRegistration & { lastHeartbeat: string }>();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly stateFilePath: string;
  private readonly presenceTimeoutMs: number;
  private ready: Promise<void>;

  constructor(options: AgentHubOptions = {}) {
    this.stateFilePath = options.stateFilePath ?? `${process.cwd()}/.nexus-agent-state.json`;
    this.presenceTimeoutMs = options.presenceTimeoutMs ?? 45000;
    this.ready = this.loadState();
  }

  private async loadState(): Promise<void> {
    try {
      const fs = await import('node:fs/promises');
      const raw = await fs.readFile(this.stateFilePath, 'utf8');
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.tasks)) {
        for (const task of parsed.tasks) this.tasks.set(task.id, task as AgentTask);
      }
      if (Array.isArray(parsed.events)) {
        for (const event of parsed.events) this.eventLog.push(event as AgentEvent);
      }
      if (Array.isArray(parsed.agents)) {
        for (const agent of parsed.agents) this.agents.set(agent.agentId, { ...agent, lastHeartbeat: agent.lastHeartbeat ?? new Date().toISOString() });
      }
    } catch {
      // state file may not exist yet; ignore and continue
    }
  }

  private async persistState(): Promise<void> {
    try {
      const fs = await import('node:fs/promises');
      const snapshot = {
        tasks: [...this.tasks.values()],
        events: this.eventLog.slice(0, 50),
        agents: [...this.agents.values()],
      };
      await fs.writeFile(this.stateFilePath, JSON.stringify(snapshot, null, 2));
    } catch {
      // keep runtime working even if persistence is unavailable
    }
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentEvent): AgentEvent {
    this.eventLog.unshift(event);
    this.listeners.forEach((listener) => listener(event));
    void this.persistState();
    return event;
  }

  async registerAgent(agent: AgentRegistration): Promise<AgentRegistration & { lastHeartbeat: string }> {
    await this.ready;
    const item = { ...agent, presence: agent.presence ?? 'online', lastHeartbeat: new Date().toISOString() };
    this.agents.set(agent.agentId, item);
    this.emit(createAgentEvent('IDLE', agent.agentId, `Agent registered: ${agent.kind}`));
    await this.persistState();
    return item;
  }

  async heartbeat(agentId: string): Promise<AgentPresence> {
    await this.ready;
    const agent = this.agents.get(agentId);
    const status = agent?.presence ?? 'online';
    const presence: AgentPresence = {
      agentId,
      status,
      capabilities: agent?.capabilities ?? [],
      heartbeatAt: new Date().toISOString(),
      connected: status !== 'offline',
    };

    if (agent) {
      agent.lastHeartbeat = presence.heartbeatAt;
    }
    this.emit(createAgentEvent('IDLE', agentId, 'Heartbeat', undefined, { status }));
    return presence;
  }

  async getAgents(): Promise<Array<AgentRegistration & { lastHeartbeat: string }>> {
    await this.ready;
    const now = Date.now();
    return [...this.agents.values()].map((agent) => ({
      ...agent,
      presence: now - new Date(agent.lastHeartbeat).getTime() > this.presenceTimeoutMs ? 'offline' : agent.presence,
    }));
  }

  async submitTask(task: AgentTask): Promise<AgentTask> {
    await this.ready;
    this.tasks.set(task.id, task);
    this.emit(createAgentEvent('DELEGATING', task.assignedTo, `Task submitted: ${task.goal}`, task.id, { scope: task.scope }));
    await this.persistState();
    return task;
  }

  getTask(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(status?: AgentTaskStatus): AgentTask[] {
    const tasks = [...this.tasks.values()];
    return status ? tasks.filter((task) => task.status === status) : tasks;
  }

  async updateTask(taskId: string, patch: Partial<AgentTask>): Promise<AgentTask | undefined> {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    const next = {
      ...task,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, next);
    await this.persistState();
    return next;
  }

  async claimTask(taskId: string, agentId: string): Promise<AgentTask | undefined> {
    await this.ready;
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    if (task.status === 'DONE') return task;

    const activeLease = task.lease && new Date(task.lease.expiresAt).getTime() > Date.now();
    if (activeLease && task.lease?.owner !== agentId) {
      return undefined;
    }

    const updated = await this.updateTask(taskId, {
      assignedTo: agentId,
      status: 'WORKING',
      progress: Math.max(task.progress ?? 0, 10),
      attempt: (task.attempt ?? 0) + 1,
      lease: { owner: agentId, expiresAt: new Date(Date.now() + 300000).toISOString() },
    });
    this.emit(createAgentEvent('EXECUTING', agentId, `Task claimed: ${task.goal}`, taskId));
    return updated;
  }

  async leaseTask(taskId: string, owner: string, ttlMs = 300000): Promise<AgentTask | undefined> {
    await this.ready;
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    if (task.lease && task.lease.owner !== owner && new Date(task.lease.expiresAt).getTime() > Date.now()) {
      return undefined;
    }
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const next = await this.updateTask(taskId, {
      assignedTo: owner,
      status: 'WORKING',
      lease: { owner, expiresAt },
    });
    this.emit(createAgentEvent('EXECUTING', owner, `Task leased: ${task.goal}`, taskId, { expiresAt }));
    return next;
  }

  async expireLeases(): Promise<AgentTask[]> {
    await this.ready;
    const expired: AgentTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.lease && new Date(task.lease.expiresAt).getTime() <= Date.now()) {
        const refreshed = await this.updateTask(task.id, {
          status: 'BLOCKED',
          error: 'Lease expired',
          lease: null,
        });
        if (refreshed) expired.push(refreshed);
      }
    }
    return expired;
  }

  async transferTask(taskId: string, nextOwner: string): Promise<AgentTask | undefined> {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const next = await this.updateTask(taskId, {
      assignedTo: nextOwner,
      status: 'TODO',
      lease: null,
    });
    this.emit(createAgentEvent('DELEGATING', nextOwner, `Task transferred from ${task.assignedTo} to ${nextOwner}`, taskId));
    return next;
  }

  async completeTask(taskId: string, result: AgentResult): Promise<AgentTask | undefined> {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const next = await this.updateTask(taskId, {
      status: 'DONE',
      progress: 100,
      result,
      error: undefined,
      lease: null,
    });
    this.emit(createAgentEvent('SPEAKING', task.assignedTo, `Task complete: ${result.summary}`, taskId, { result }));
    return next;
  }

  async failTask(taskId: string, error: string): Promise<AgentTask | undefined> {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const next = await this.updateTask(taskId, {
      status: 'BLOCKED',
      error,
      lease: null,
    });
    this.emit(createAgentEvent('ERROR', task.assignedTo, `Task blocked: ${error}`, taskId, { error }));
    return next;
  }

  async cancelTask(taskId: string): Promise<AgentTask | undefined> {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const next = await this.updateTask(taskId, {
      status: 'BLOCKED',
      error: 'Cancelled by owner',
      lease: null,
    });
    this.emit(createAgentEvent('INTERRUPTED', task.assignedTo, `Task cancelled: ${task.goal}`, taskId));
    return next;
  }

  getEventLog(limit = 20): AgentEvent[] {
    return this.eventLog.slice(0, limit);
  }

  capabilities(): AgentCapability[] {
    return [
      { name: 'presence', description: 'Presence updates', supported: true },
      { name: 'task-submit', description: 'Submit and assign work', supported: true },
      { name: 'task-lease', description: 'Lease and transfer tasks', supported: true },
      { name: 'events', description: 'Event stream and log', supported: true },
    ];
  }
}
