import { AIModelMode, ModelRouter } from './modelRouter.ts';
import { MemoryStore } from './memoryStore.ts';
import { ToolRegistry } from './toolRegistry.ts';

export type NexusMessageInput = {
  text: string;
  mode?: AIModelMode;
  projectContext?: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
};

export type NexusAgentResult = {
  text: string;
  mode: AIModelMode;
  reasoning: string[];
};

export class NexusAgent {
  constructor(
    private readonly router: ModelRouter,
    private readonly memoryStore: MemoryStore,
    private readonly toolRegistry: ToolRegistry,
    private readonly options: { systemPrompt?: string } = {},
  ) {}

  async send(input: NexusMessageInput): Promise<NexusAgentResult> {
    const relevantMemories = await this.memoryStore.getRelevantMemories(input.text, 3);
    const toolHints = this.toolRegistry.list().slice(0, 5).map((tool) => tool.name).join(', ');

    const memoryContext = relevantMemories.length
      ? `Relevant memories:\n${relevantMemories.map((m) => `- ${m.text}`).join('\n')}`
      : 'No relevant memories yet.';

    const prompt = [
      this.options.systemPrompt || 'You are Nexus, a local-first AI assistant for product work and coding.',
      `Project context: ${input.projectContext || 'No project context provided.'}`,
      `Current AI mode: ${input.mode || 'AUTO'}`,
      `Available tools: ${toolHints || 'none'}`,
      memoryContext,
      `User message: ${input.text}`,
    ].join('\n\n');

    const responseText = await this.router.route(prompt, { temperature: 0.2 });

    await this.memoryStore.saveMemory({
      text: input.text,
      category: 'user-turn',
      tags: ['user', 'conversation'],
    });

    await this.memoryStore.saveMemory({
      text: responseText,
      category: 'assistant-turn',
      tags: ['assistant', 'conversation'],
    });

    return {
      text: responseText,
      mode: input.mode || 'AUTO',
      reasoning: [
        'Selected local-first model routing',
        'Retrieved the most relevant memory snippets',
        'Prepared tool-aware context for the next response',
      ],
    };
  }
}
