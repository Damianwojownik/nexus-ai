import type { AgentRegistration } from './agentHub.ts';
import type { AgentEvent, AgentPresence, AgentResult, AgentTask, AgentTaskStatus } from './agentProtocol.ts';

export type AgentHubConnectionStatus = 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
export type NewAgentHubTask = Pick<AgentTask, 'goal' | 'createdBy' | 'assignedTo' | 'scope'> & { contextRefs?: string[] };

type AgentHubResponse<T> = T;

const viteEnv = import.meta.env;
const processEnv = typeof process !== 'undefined' ? process.env : undefined;
const defaultBaseUrl = viteEnv?.VITE_NEXUS_AGENT_HUB_URL || processEnv?.NEXUS_AGENT_HUB_URL || 'http://127.0.0.1:8788';

export class AgentHubClientError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class AgentHubClient {
  readonly baseUrl: string;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;

  constructor(baseUrl = defaultBaseUrl, reconnectDelayMs = 300, maxReconnectDelayMs = 5000) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.reconnectDelayMs = reconnectDelayMs;
    this.maxReconnectDelayMs = maxReconnectDelayMs;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<AgentHubResponse<T>> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        signal: init.signal ?? AbortSignal.timeout(10000),
      });
    } catch (error) {
      throw new AgentHubClientError(error instanceof Error ? error.message : 'Agent Hub is unreachable');
    }

    if (!response.ok) {
      let detail = `Agent Hub returned HTTP ${response.status}`;
      try {
        const body = await response.json() as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        // Keep the HTTP status as the actionable error.
      }
      throw new AgentHubClientError(detail, response.status);
    }

    return response.json() as Promise<AgentHubResponse<T>>;
  }

  async health(): Promise<void> {
    await this.request<{ ok: boolean }>('/api/health');
  }

  async getAvatarHealth(): Promise<{ status: string; ok: boolean; message?: string; provider?: string; mode?: string }> {
    return this.request('/api/avatar/health');
  }

  async renderAvatar(input: {
    sourceImageBase64: string;
    sourceImageMime?: string;
    audioBase64?: string;
    audioMime?: string;
    drivingVideoBase64?: string;
    drivingVideoMime?: string;
  }): Promise<Blob> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/avatar/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
    } catch (error) {
      throw new AgentHubClientError(error instanceof Error ? error.message : 'Avatar render endpoint is unreachable');
    }
    if (!response.ok) {
      let detail = `Avatar render returned HTTP ${response.status}`;
      try {
        const body = await response.json() as { error?: string };
        if (body.error) detail = body.error;
      } catch {}
      throw new AgentHubClientError(detail, response.status);
    }
    return response.blob();
  }

  async getAgents(): Promise<Array<AgentRegistration & { lastHeartbeat: string }>> {
    const result = await this.request<{ agents: Array<AgentRegistration & { lastHeartbeat: string }> }>('/api/agents');
    return result.agents;
  }

  async registerAgent(agent: AgentRegistration): Promise<AgentRegistration & { lastHeartbeat: string }> {
    const result = await this.request<{ agent: AgentRegistration & { lastHeartbeat: string } }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify(agent),
    });
    return result.agent;
  }

  async heartbeat(agentId: string): Promise<AgentPresence> {
    const result = await this.request<{ presence: AgentPresence }>(`/api/agents/${encodeURIComponent(agentId)}/heartbeat`, {
      method: 'POST',
    });
    return result.presence;
  }

  async getTasks(status?: AgentTaskStatus): Promise<AgentTask[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    const result = await this.request<{ tasks: AgentTask[] }>(`/api/tasks${query}`);
    return result.tasks;
  }

  async submitTask(task: NewAgentHubTask): Promise<AgentTask> {
    const result = await this.request<{ task: AgentTask }>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(task),
    });
    return result.task;
  }

  async claimTask(taskId: string, agentId: string): Promise<AgentTask> {
    const result = await this.request<{ task: AgentTask }>(`/api/tasks/${encodeURIComponent(taskId)}/claim`, {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    });
    return result.task;
  }

  async leaseTask(taskId: string, owner: string, ttlMs = 300000): Promise<AgentTask> {
    const result = await this.request<{ task: AgentTask }>(`/api/tasks/${encodeURIComponent(taskId)}/lease`, {
      method: 'POST',
      body: JSON.stringify({ owner, ttlMs }),
    });
    return result.task;
  }

  async completeTask(taskId: string, result: AgentResult): Promise<AgentTask> {
    const response = await this.request<{ task: AgentTask }>(`/api/tasks/${encodeURIComponent(taskId)}/complete`, {
      method: 'POST',
      body: JSON.stringify({ result }),
    });
    return response.task;
  }

  async failTask(taskId: string, error: string): Promise<AgentTask> {
    const response = await this.request<{ task: AgentTask }>(`/api/tasks/${encodeURIComponent(taskId)}/fail`, {
      method: 'POST',
      body: JSON.stringify({ error }),
    });
    return response.task;
  }

  subscribeEvents(
    onEvent: (event: AgentEvent) => void,
    onStatus: (status: AgentHubConnectionStatus) => void,
  ): () => void {
    const controller = new AbortController();
    let closed = false;
    let reconnectDelay = this.reconnectDelayMs;

    const run = async () => {
      while (!closed) {
        try {
          const response = await fetch(`${this.baseUrl}/api/events`, {
            headers: { Accept: 'text/event-stream' },
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new AgentHubClientError(`Agent Hub event stream returned HTTP ${response.status}`, response.status);
          }
          if (!response.body) throw new AgentHubClientError('Agent Hub event stream has no response body');

          reconnectDelay = this.reconnectDelayMs;
          onStatus('CONNECTED');
          await this.readEventStream(response.body, onEvent);
          if (!closed) onStatus('DISCONNECTED');
        } catch (error) {
          if (closed) return;
          onStatus(error instanceof AgentHubClientError ? 'ERROR' : 'DISCONNECTED');
        }

        await this.waitBeforeReconnect(reconnectDelay, controller.signal);
        reconnectDelay = Math.min(this.maxReconnectDelayMs, Math.max(this.reconnectDelayMs, reconnectDelay * 2));
      }
    };

    void run();
    return () => {
      closed = true;
      controller.abort();
    };
  }

  private async readEventStream(body: ReadableStream<Uint8Array>, onEvent: (event: AgentEvent) => void): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines: string[] = [];

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line === '') {
            if (dataLines.length) {
              let event: unknown;
              try {
                event = JSON.parse(dataLines.join('\n'));
              } catch {
                throw new AgentHubClientError('Agent Hub sent an invalid SSE event');
              }
              if (!isAgentEvent(event)) throw new AgentHubClientError('Agent Hub sent an invalid SSE event');
              onEvent(event);
              dataLines = [];
            }
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async waitBeforeReconnect(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timeout = setTimeout(finish, delayMs);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Partial<AgentEvent>;
  return typeof event.id === 'string'
    && typeof event.type === 'string'
    && typeof event.agentId === 'string'
    && typeof event.message === 'string'
    && typeof event.at === 'string';
}