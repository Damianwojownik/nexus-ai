# Independent Nexus AI

## Product boundary

Nexus is a standalone application. It does not import, call, depend on, or modify Ezostylia. Its tools are owned by the Nexus repository and are connected through Nexus APIs, local services, or optional provider adapters. No Ezostylia source, assets, runtime, API or gateway are required.

The source of truth is `Damianwojownik/nexus-ai`. The separate `my-friend-ai` Railway project is outside this repository's change scope and must not be changed as part of Nexus work.

## Architecture

1. **Chat UI** — Polish-first conversation, visible transcript, browser-local history (last 100 messages), voice input, speech output, attachments and workflow status.
2. **Nexus Core** — prompt assembly, provider routing, memory retrieval, bounded model tool-call loop.
3. **Tool registry** — capability schemas, validation, timeout and permission gate. Only explicitly opted-in, read-only, non-destructive, permission-free tools can be invoked by the model.
4. **Agent Hub** — task queue, parent/child tasks, leases, presence/heartbeats and SSE events.
5. **Specialist coordinator** — seven logical SEO roles, dependency-aware phases, parallel phase-one work, Content/AEO phase two, independent reviewer phase three.
6. **Providers** — existing local Ollama and optional configured cloud/CLI providers. Specialist workers currently share the configured model router/provider; they are isolated role prompts and tasks, not seven separate paid model instances.
7. **Storage** — chat history in the current browser's localStorage; local Agent Hub task state/workspace on the local runtime. There is no multi-user hosted database yet.

## Implemented in the independent-core branch

### Chat and safe tools
- Explicit JSON action protocol:
  - `{"type":"tool_call","name":"web_search","arguments":{"query":"..."}}`
  - `{"type":"final","text":"..."}`
- At most four model tool calls per turn.
- Only tools explicitly marked `modelCallable: true`, read-only, non-destructive and permission-free are available to model-driven execution.
- Current safe tool set: web search, weather, technical SEO crawl, PageSpeed Insights, integration status, Search Console, GA4 and read-only Google Business Profile audit (the latter four return a truthful not-configured error until authorized/configured).
- Filesystem writes, shell commands, installers and Git mutations are unavailable to model-driven tool calls.
- The chat transcript is visible and persisted in the current browser's localStorage (last 100 messages); it is not synced across devices or users.

### SEO / AEO
- Bounded public-site crawler (maximum 30 pages per run): robots.txt, sitemap, HTTP status, title/description, canonicals, meta robots/noindex, H1/headings, image alt, same-origin links, duplicate titles and JSON-LD.
- SSRF defenses: rejects private/loopback/reserved IP addresses, permits standard HTTP/S ports, pins DNS resolution for outbound requests, limits response size/time/redirects and blocks redirects to other hosts.
- Main-content excerpts and heading outlines are passed to the Content/AEO specialist for actual content review.
- AEO signals include question headings, FAQ/JSON-LD types, content length and an explicitly heuristic readiness indicator. This is not a measurement of rankings or AI answer visibility.
- Google PageSpeed Insights integration: Lighthouse categories and lab metrics, with optional CrUX field data clearly separated.
- Report UI includes issue priorities, recommendations, CSV export and browser print/save-to-PDF.
- Search Console read-only report support, with OAuth scope `webmasters.readonly`.
- GA4 read-only report support, with OAuth scope `analytics.readonly`.
- Google Business Profile read-only location audit with `business.manage`; reads business name, website, phone, address and hours. Does not edit listings, read reviews or measure Maps rankings.
- Semrush API is reported as a paid integration; no paid requests are run without a separate explicit approval.

### SEO specialist hierarchy
- Phase 1 parallel: Technical SEO, Keyword/Competitor Research, Search Console/GA4 Analytics, Backlink Intelligence, Local SEO.
- Phase 2: Content SEO/AEO receives the phase-one reports and page content excerpts.
- Phase 3: Independent Reviewer receives the reports, has tools disabled, checks evidence/contradictions and produces prioritized action plan.
- Child work is recorded in Agent Hub with parent ID, skill references, leases and heartbeat presence.
- Specialist workers currently use the same configured Nexus model router/provider. They are separate tasks/role prompts executed concurrently, not independent model subscriptions or external workers.

### Google OAuth setup
The server requires these environment variables in its own process (never in browser `VITE_*` variables):
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`
- `GOOGLE_SEARCH_CONSOLE_SITE_URL` — the exact verified GSC property URL or `sc-domain:example.com`
- `GOOGLE_GA4_PROPERTY_ID` — numeric GA4 property ID
- `GOOGLE_BUSINESS_PROFILE_LOCATION_ID` — e.g. `locations/123456789`

OAuth uses Authorization Code + PKCE with offline access and the read-only GSC/GA4 scopes plus Business Profile `business.manage`. Refresh tokens are stored in a protected local file with restrictive file permissions (default Windows LocalAppData/NexusAI or `~/.nexus-ai`). The local token file is not a multi-user cloud secrets store and is not encrypted at rest. A public hosted runtime must use a proper encrypted secrets manager and tenant-scoped token storage before it can use this design.

## Not yet production-ready

- The specialist roles are actual parallel logical tasks in one configured Nexus runtime, but are not separate independently provisioned cloud workers.
- Keyword volume, CPC, keyword difficulty, domain competitor metrics and backlink counts require a connected data source such as Semrush/Ahrefs. Nexus must not invent them.
- Semrush API access and API units may be paid. No paid calls are performed automatically.
- Google OAuth is implemented but needs a Google Cloud OAuth client, authorized redirect URI, consent-screen setup and user authorization. Private GSC/GA4/GBP data is not accessible until these are configured.
- A public-site crawl is limited and does not execute browser JavaScript, authenticate or submit forms. Lighthouse/CrUX and crawler results are measurements, not ranking guarantees.
- The image generation bridge exists in the repository, but a production GPU render has not been verified.
- No account system, multi-user tenant isolation, hosted database, production authentication layer or public Nexus deployment has been completed.

## Public hosting security gate

The Agent Hub binds to loopback by default (`127.0.0.1:8788`). It does not yet have a complete authentication/session layer for private APIs. Do not expose it publicly or change the bind address to `0.0.0.0` until all of the following are implemented and tested:

- authenticated user sessions and authorization on every private API route;
- encrypted server-side secrets and tenant-scoped OAuth tokens;
- strict production CORS/origin policy and rate limits;
- isolated per-user workspaces and persistent database access controls;
- hardened SSRF controls for crawler/browser tools;
- audit logs and explicit user approval for destructive operations.

## Development checks

```sh
npm ci
npm run build
npm run test:agent
npm run test:team
npm run test:seo
npm run test:hub
npm run test:image
npm run test:image-hub
```

## Delivery sequence

1. Keep the independent-core branch build/test green and review its changes.
2. Complete public-runtime authentication, user isolation, secret management, abuse/rate controls and persistent multi-user storage.
3. Add verified keyword/backlink data-provider integrations, only after provider access and any cost are approved.
4. Complete OAuth tenant handling and production deployment hardening.
5. Deploy a separate Nexus environment only after explicit hosting approval. Never use or alter Ezostylia or the unrelated `my-friend-ai` service.
