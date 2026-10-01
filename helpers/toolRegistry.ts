export type ToolInputSchema = Record<string, any>;

export interface ToolExecutionContext {
  signal?: AbortSignal;
  allowDestructive?: boolean;
  permissions?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  execute: (args: Record<string, any>, context?: ToolExecutionContext) => Promise<any>;
  destructive?: boolean;
  requiredPermissions?: string[];
  timeoutMs?: number;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition) { this.tools.set(tool.name, tool); }
  get(name: string) { return this.tools.get(name); }
  list() { return [...this.tools.values()]; }

  async execute(name: string, args: Record<string, any> = {}, context: ToolExecutionContext = {}) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    if (tool.destructive && !context.allowDestructive) {
      throw new Error(`Tool requires destructive-action approval: ${name}`);
    }

    const permissions = new Set(context.permissions ?? []);
    for (const permission of tool.requiredPermissions ?? []) {
      if (!permissions.has(permission)) throw new Error(`Missing permission ${permission} for tool ${name}`);
    }

    const timeoutMs = tool.timeoutMs ?? 30000;
    return await Promise.race([
      tool.execute(args, context),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Tool timed out after ${timeoutMs}ms: ${name}`)), timeoutMs)),
    ]);
  }
}
