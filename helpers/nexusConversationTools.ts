import type { LocalCapabilitiesClient } from './localCapabilitiesClient.ts';
import type { ToolRegistry } from './toolRegistry.ts';

/**
 * Register a small, explicitly safe conversation toolset.
 * These tools are read-only and cannot access the user's filesystem or run commands.
 */
export function registerConversationTools(registry: ToolRegistry, capabilities: LocalCapabilitiesClient): void {
  registry.register({
    name: 'web_search',
    description: 'Search the public web for current information. Returns titles, URLs and snippets; use the URLs as source references.',
    permissionLevel: 'read',
    modelCallable: true,
    timeoutMs: 25000,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 2, maxLength: 300 } },
      required: ['query'],
      additionalProperties: false,
    },
    validate: ({ query }) => (
      typeof query === 'string' && query.trim().length >= 2 && query.trim().length <= 300
        ? { ok: true }
        : { ok: false, error: 'query must contain 2 to 300 characters' }
    ),
    execute: async ({ query }, context) => {
      if (context?.signal?.aborted) throw new Error('Web search was cancelled');
      return capabilities.searchWeb(String(query).trim());
    },
  });

  registry.register({
    name: 'get_weather',
    description: 'Get current weather and forecast for a named city or location.',
    permissionLevel: 'read',
    modelCallable: true,
    timeoutMs: 20000,
    inputSchema: {
      type: 'object',
      properties: { location: { type: 'string', minLength: 2, maxLength: 120 } },
      required: ['location'],
      additionalProperties: false,
    },
    validate: ({ location }) => (
      typeof location === 'string' && location.trim().length >= 2 && location.trim().length <= 120
        ? { ok: true }
        : { ok: false, error: 'location must contain 2 to 120 characters' }
    ),
    execute: async ({ location }, context) => {
      if (context?.signal?.aborted) throw new Error('Weather lookup was cancelled');
      return capabilities.getWeather(String(location).trim());
    },
  });
}
