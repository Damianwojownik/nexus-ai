export type AgentTaskStatus = 'TODO' | 'WORKING' | 'BLOCKED' | 'DONE';
export type AgentPresenceStatus = 'online' | 'offline' | 'busy';
export type AgentKind = 'orchestrator' | 'primary' | 'codex' | 'ollama' | 'reviewer' | 'researcher' | 'memory' | 'tool';
export type AgentMessageType = 'message' | 'task' | 'event' | 'result';
export type VoiceEventType = 'IDLE' | 'LISTENING' | 'THINKING' | 'DELEGATING' | 'EXECUTING' | 'SPEAKING' | 'WAITING_FOR_APPROVAL' | 'INTERRUPTED' | 'ERROR';
export type AgentPriority = 'low' | 'normal' | 'high' | 'critical';

export interface AgentCapability {
  name: string;
  description: string;
  supported: boolean;
}

export interface AgentPresence {
  agentId: string;
  status: AgentPresenceStatus;
  capabilities: string[];
  heartbeatAt: string;
  connected: boolean;
}

export interface AgentMessage {
  id: string;
  from: string;
  to?: string;
  type: AgentMessageType;
  content: string;
  createdAt: string;
}

export interface AgentResult {
  status: 'SUCCESS' | 'ERROR' | 'PARTIAL';
  summary: string;
  payload?: unknown;
}

export interface AgentTask {
  id: string;
  parentId?: string;
  createdBy: string;
  assignedTo: string;
  status: AgentTaskStatus;
  goal: string;
  contextRefs: string[];
  scope: string;
  createdAt: string;
  updatedAt: string;
  lease?: {
    owner: string;
    expiresAt: string;
  } | null;
  progress: number;
  result?: AgentResult;
  error?: string;
  attempt: number;
  priority: AgentPriority;
}

export interface AgentEvent {
  id: string;
  type: VoiceEventType;
  agentId: string;
  taskId?: string;
  message: string;
  at: string;
  metadata?: Record<string, unknown>;
}

export function createTask(params: Partial<AgentTask> & Pick<AgentTask, 'goal' | 'createdBy' | 'assignedTo' | 'scope'>): AgentTask {
  const now = new Date().toISOString();

  return {
    id: params.id ?? `task-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    parentId: params.parentId,
    createdBy: params.createdBy,
    assignedTo: params.assignedTo,
    status: params.status ?? 'TODO',
    goal: params.goal,
    contextRefs: params.contextRefs ?? [],
    scope: params.scope,
    createdAt: params.createdAt ?? now,
    updatedAt: params.updatedAt ?? now,
    lease: params.lease ?? null,
    progress: params.progress ?? 0,
    result: params.result,
    error: params.error,
    attempt: params.attempt ?? 0,
    priority: params.priority ?? 'normal',
  };
}

export function createMessage(params: Partial<AgentMessage> & Pick<AgentMessage, 'from' | 'content'>): AgentMessage {
  return {
    id: params.id ?? `message-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    from: params.from,
    to: params.to,
    type: params.type ?? 'message',
    content: params.content,
    createdAt: params.createdAt ?? new Date().toISOString(),
  };
}

export function createAgentEvent(
  type: VoiceEventType,
  agentId: string,
  message: string,
  taskId?: string,
  metadata?: Record<string, unknown>,
): AgentEvent {
  return {
    id: `event-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    agentId,
    taskId,
    message,
    at: new Date().toISOString(),
    metadata,
  };
}
