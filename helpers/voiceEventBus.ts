import type { AgentEvent, VoiceEventType } from './agentProtocol.ts';

export type VoiceEventListener = (event: AgentEvent) => void;

export interface VoiceAnimationMetadata {
  viseme?: string;
  phonemeTiming?: number[];
  speechEnergy?: number;
  expression?: string;
  gaze?: string;
  gesture?: string;
  [key: string]: unknown;
}

export class VoiceEventBus {
  private listeners = new Set<VoiceEventListener>();

  subscribe(listener: VoiceEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type: VoiceEventType, agentId: string, message: string, taskId?: string, metadata?: VoiceAnimationMetadata) {
    const event: AgentEvent = {
      id: `voice-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      type,
      agentId,
      taskId,
      message,
      at: new Date().toISOString(),
      metadata,
    };

    this.listeners.forEach((listener) => listener(event));
    return event;
  }

  clear() {
    this.listeners.clear();
  }
}
