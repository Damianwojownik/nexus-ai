import { agentCore } from "./agentCore";
export async function agentBackgroundStep(payload: { conversationId: number; iteration?: number }) {
  await agentCore.agentBackgroundStep({ conversationId: payload.conversationId, iteration: payload.iteration ?? 0 });
}
