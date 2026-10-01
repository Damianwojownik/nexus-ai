export type ToolPermissionLevel = 'read' | 'write' | 'exec' | 'git';
export type ToolInputSchema = Record<string, any>;

export interface ToolValidationResult {
  ok: boolean;
  error?: string;
}

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
  permissionLevel?: ToolPermissionLevel;
  destructive?: boolean;
  requiredPermissions?: string[];
  timeoutMs?: number;
  validate?: (args: Record<string, any>) => ToolValidationResult;
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
      throw new Error(`Tool ${name} requires explicit approval before destructive action.`);
    }

    const permissions = new Set(context.permissions ?? []);
    for (const permission of tool.requiredPermissions ?? []) {
      if (!permissions.has(permission)) throw new Error(`Missing permission ${permission} for tool ${name}`);
    }

    const validation = tool.validate?.(args);
    if (validation && !validation.ok) {
      throw new Error(validation.error ?? `Validation failed for ${name}`);
    }

    const timeoutMs = tool.timeoutMs ?? 30000;
    const controller = new AbortController();
    const propagateAbort = () => controller.abort(context.signal?.reason);
    if (context.signal?.aborted) propagateAbort();
    else context.signal?.addEventListener('abort', propagateAbort, { once: true });

    let timeout: ReturnType<typeof setTimeout>;
    const timeoutResult = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`Tool timed out after ${timeoutMs}ms: ${name}`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        tool.execute(args, { ...context, signal: controller.signal }),
        timeoutResult,
      ]);
    } finally {
      clearTimeout(timeout!);
      context.signal?.removeEventListener('abort', propagateAbort);
    }
  }
}

export function registerDefaultTools(registry: ToolRegistry) {
  registry.register({
    name: 'read_file',
    description: 'Read a local file from the workspace.',
    permissionLevel: 'read',
    destructive: false,
    timeoutMs: 10000,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    validate: ({ path }) => (!path ? { ok: false, error: 'path is required' } : { ok: true }),
    execute: async ({ path }) => {
      const fs = await import('node:fs/promises');
      return fs.readFile(path, 'utf8');
    },
  });

  registry.register({
    name: 'write_file',
    description: 'Write a file to disk.',
    permissionLevel: 'write',
    destructive: false,
    timeoutMs: 15000,
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    validate: ({ path, content }) => (!path || typeof content !== 'string' ? { ok: false, error: 'path and content are required' } : { ok: true }),
    execute: async ({ path, content }) => {
      const fs = await import('node:fs/promises');
      await fs.mkdir(require('node:path').dirname(path), { recursive: true });
      await fs.writeFile(path, content, 'utf8');
      return { ok: true, path };
    },
  });

  registry.register({
    name: 'list_files',
    description: 'List files in a directory.',
    permissionLevel: 'read',
    destructive: false,
    timeoutMs: 10000,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    validate: ({ path }) => (!path ? { ok: false, error: 'path is required' } : { ok: true }),
    execute: async ({ path }) => {
      const fs = await import('node:fs/promises');
      return fs.readdir(path);
    },
  });

  registry.register({
    name: 'search_files',
    description: 'Search files by name or content.',
    permissionLevel: 'read',
    destructive: false,
    timeoutMs: 12000,
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, query: { type: 'string' } }, required: ['path', 'query'] },
    validate: ({ path, query }) => (!path || !query ? { ok: false, error: 'path and query are required' } : { ok: true }),
    execute: async ({ path, query }) => {
      const fs = await import('node:fs/promises');
      const dir = await fs.readdir(path, { withFileTypes: true });
      return dir.filter((entry) => entry.name.toLowerCase().includes(String(query).toLowerCase()) || entry.isDirectory()).map((entry) => entry.name);
    },
  });

  registry.register({
    name: 'run_tests',
    description: 'Run repository tests if the runtime supports them.',
    permissionLevel: 'exec',
    destructive: false,
    timeoutMs: 20000,
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    validate: ({ command }) => (!command ? { ok: false, error: 'command is required' } : { ok: true }),
    execute: async ({ command }) => {
      const cp = await import('node:child_process');
      return await new Promise((resolve, reject) => {
        cp.exec(command, (error, stdout, stderr) => {
          if (error) return reject(error);
          resolve({ stdout, stderr });
        });
      });
    },
  });

  registry.register({
    name: 'git_status',
    description: 'Check repository status without changing files.',
    permissionLevel: 'git',
    destructive: false,
    timeoutMs: 15000,
    inputSchema: { type: 'object', properties: { cwd: { type: 'string' } }, required: ['cwd'] },
    validate: ({ cwd }) => (!cwd ? { ok: false, error: 'cwd is required' } : { ok: true }),
    execute: async ({ cwd }) => {
      const cp = await import('node:child_process');
      return await new Promise((resolve, reject) => {
        cp.exec('git status --short --branch', { cwd }, (error, stdout, stderr) => {
          if (error) return reject(error);
          resolve({ stdout, stderr });
        });
      });
    },
  });

  registry.register({
    name: 'git_commit',
    description: 'Create a git commit. Requires explicit approval because it is destructive and permanent.',
    permissionLevel: 'git',
    destructive: true,
    timeoutMs: 20000,
    inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, message: { type: 'string' } }, required: ['cwd', 'message'] },
    validate: ({ cwd, message }) => (!cwd || !message ? { ok: false, error: 'cwd and message are required' } : { ok: true }),
    execute: async ({ cwd, message }, context) => {
      const cp = await import('node:child_process');
      if (!context?.allowDestructive) {
        throw new Error('git_commit requires allowDestructive=true');
      }
      return await new Promise((resolve, reject) => {
        cp.exec(`git add . && git commit -m ${JSON.stringify(message)}`, { cwd }, (error, stdout, stderr) => {
          if (error) return reject(error);
          resolve({ stdout, stderr });
        });
      });
    },
  });
}
