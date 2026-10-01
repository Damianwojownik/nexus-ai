export type ToolInputSchema = Record<string, any>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  execute: (args: Record<string, any>) => Promise<any>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition) {
    this.tools.set(tool.name, tool);
  }

  get(name: string) {
    return this.tools.get(name);
  }

  list() {
    return [...this.tools.values()];
  }

  async execute(name: string, args: Record<string, any> = {}) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    return tool.execute(args);
  }
}
