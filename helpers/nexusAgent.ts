import { ModelRouter } from './modelRouter.ts';
import type { AIModelMode } from './modelRouter.ts';
import { MemoryStore } from './memoryStore.ts';
import { ToolRegistry } from './toolRegistry.ts';
import { LUNA_IDENTITY, LUNA_EMOTION_CONTEXT } from './assistantPersona.ts';

export type NexusMessageInput = {
  text: string;
  mode?: AIModelMode;
  projectContext?: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxOutputTokens?: number;
  onToken?: (chunk: string) => void;
};

export type NexusAgentResult = {
  text: string;
  mode: AIModelMode;
  reasoning: string[];
};

export class NexusAgent {
  private readonly router: ModelRouter;
  private readonly memoryStore: MemoryStore;
  private readonly toolRegistry: ToolRegistry;
  private readonly options: { systemPrompt?: string };

  constructor(
    router: ModelRouter,
    memoryStore: MemoryStore,
    toolRegistry: ToolRegistry,
    options: { systemPrompt?: string } = {},
  ) {
    this.router = router;
    this.memoryStore = memoryStore;
    this.toolRegistry = toolRegistry;
    this.options = options;
  }

  async send(input: NexusMessageInput): Promise<NexusAgentResult> {
    const mode = input.mode || 'AUTO';
    this.router.setPreferredMode(mode);

    const relevantMemories = await this.memoryStore.getRelevantMemories(input.text, 3);
    const toolHints = this.toolRegistry.list().slice(0, 5).map((tool) => tool.name).join(', ');
    const history = (input.history || []).slice(-12);

    const memoryContext = relevantMemories.length
      ? `Relevant memories:\n${relevantMemories.map((m) => `- ${m.text}`).join('\n')}`
      : 'No relevant memories yet.';

    const historyContext = history.length
      ? `Recent conversation:\n${history.map((item) => `${item.role}: ${item.content}`).join('\n')}`
      : 'No recent conversation history provided.';

    const prompt = [
      this.options.systemPrompt || 'You are a local-first AI assistant for product work and coding.',
      `Project context: ${input.projectContext || 'No project context provided.'}`,
      `Current AI mode: ${mode}`,
      `Available tools: ${toolHints || 'none'}`,
      memoryContext,
      historyContext,
      LUNA_IDENTITY,
      LUNA_EMOTION_CONTEXT,
      `User message: ${input.text}`,
    ].join('\n\n');

    const responseText = await this.router.route(prompt, {
      temperature: 0.2,
      numPredict: input.maxOutputTokens,
      onToken: input.onToken,
    });

    await this.memoryStore.saveMemory({
      kind: 'conversation',
      text: input.text,
      category: 'user-turn',
      tags: ['user', 'conversation'],
      owner: 'nexus',
      scope: 'chat',
      source: 'user-input',
      relevance: 0.6,
      sensitive: false,
    });

    await this.memoryStore.saveMemory({
      kind: 'conversation',
      text: responseText,
      category: 'assistant-turn',
      tags: ['assistant', 'conversation'],
      owner: 'nexus',
      scope: 'chat',
      source: 'agent-output',
      relevance: 0.7,
      sensitive: false,
    });

    return {
      text: responseText,
      mode,
      reasoning: [
        `Applied requested model mode: ${mode}`,
        'Retrieved the most relevant memory snippets',
        'Included recent conversation history and tool-aware context',
      ],
    };
  }
}
