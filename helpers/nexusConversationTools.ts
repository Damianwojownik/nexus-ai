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
  registry.register({
    name: 'technical_seo_audit',
    description: 'Crawl a public website safely and audit HTTP status, titles, descriptions, canonicals, robots.txt, sitemap, headings, links, image alt, JSON-LD and AEO content signals. Maximum 30 pages.',
    permissionLevel: 'read',
    modelCallable: true,
    timeoutMs: 180000,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 4, maxLength: 2048 },
        maxPages: { type: 'integer', minimum: 1, maximum: 30 },
      },
      required: ['url'],
      additionalProperties: false,
    },
    validate: ({ url, maxPages }) => (
      typeof url === 'string' && url.trim().length >= 4 && url.length <= 2048
        && (maxPages === undefined || (Number.isInteger(maxPages) && maxPages >= 1 && maxPages <= 30))
        ? { ok: true }
        : { ok: false, error: 'Provide a public website URL and an optional maxPages from 1 to 30' }
    ),
    execute: async ({ url, maxPages }, context) => {
      if (context?.signal?.aborted) throw new Error('SEO audit was cancelled');
      return capabilities.auditSeo(String(url), typeof maxPages === 'number' ? maxPages : 20);
    },
  });

  registry.register({
    name: 'pagespeed_audit',
    description: 'Run Google PageSpeed Insights for mobile or desktop. Returns Lighthouse lab scores, metrics, opportunities and any available field data.',
    permissionLevel: 'read',
    modelCallable: true,
    timeoutMs: 120000,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 4, maxLength: 2048 },
        strategy: { type: 'string', enum: ['mobile', 'desktop'] },
      },
      required: ['url'],
      additionalProperties: false,
    },
    validate: ({ url, strategy }) => (
      typeof url === 'string' && url.trim().length >= 4 && url.length <= 2048
        && (strategy === undefined || strategy === 'mobile' || strategy === 'desktop')
        ? { ok: true }
        : { ok: false, error: 'Provide a public URL and strategy mobile or desktop' }
    ),
    execute: async ({ url, strategy }, context) => {
      if (context?.signal?.aborted) throw new Error('PageSpeed audit was cancelled');
      return capabilities.runPageSpeed(String(url), strategy === 'desktop' ? 'desktop' : 'mobile');
    },
  });

  registry.register({
    name: 'seo_integrations_status',
    description: 'Check whether Google Search Console, GA4, Semrush backlinks and Google Business Profile credentials are configured. Never returns credential values.',
    permissionLevel: 'read',
    modelCallable: true,
    timeoutMs: 10000,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (_args, context) => {
      if (context?.signal?.aborted) throw new Error('Integration status check was cancelled');
      return capabilities.getSeoIntegrations();
    },
  });

  registry.register({
    name: 'search_console_report',
    description: 'Read Search Console query/page/device/country metrics for the configured verified property. Requires a previously authorized Google OAuth token.',
    permissionLevel: 'read',
    modelCallable: true,
    timeoutMs: 35000,
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        endDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      additionalProperties: false,
    },
    execute: async ({ startDate, endDate }, context) => {
      if (context?.signal?.aborted) throw new Error('Search Console report was cancelled');
      return capabilities.searchConsoleReport(typeof startDate === 'string' ? startDate : undefined, typeof endDate === 'string' ? endDate : undefined);
    },
  });


  registry.register({
    name: 'google_business_profile_audit',
    description: 'Read the configured Google Business Profile location and check business name, website, phone, address and opening-hours fields. Does not update the listing.',
    permissionLevel: 'read',
    modelCallable: true,
    timeoutMs: 45000,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (_args, context) => {
      if (context?.signal?.aborted) throw new Error('Business Profile audit was cancelled');
      return capabilities.googleBusinessProfileAudit();
    },
  });

  registry.register({
    name: 'ga4_report',
    description: 'Read Google Analytics 4 sessions, active users and conversions from the configured property using an authorized read-only OAuth token.',
    permissionLevel: 'read',
    modelCallable: true,
    timeoutMs: 35000,
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        endDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      additionalProperties: false,
    },
    execute: async ({ startDate, endDate }, context) => {
      if (context?.signal?.aborted) throw new Error('GA4 report was cancelled');
      return capabilities.ga4Report(typeof startDate === 'string' ? startDate : undefined, typeof endDate === 'string' ? endDate : undefined);
    },
  });

}
