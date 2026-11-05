# Independent Nexus AI

## Product boundary

Nexus is a standalone application. It does not import, call, depend on, or modify Ezostylia. Its tools are owned by the Nexus repository and are connected through Nexus APIs, local services, or optional provider adapters. Ezostylia may be added later only as an optional third-party integration, never as a runtime dependency.

The source of truth is `Damianwojownik/nexus-ai`. The existing `my-friend-ai` Railway project and the Ezostylia application are outside this repository's change scope.

## Runtime layers

1. **Chat UI** — one Polish-first conversation, message history, local browser persistence, voice input and response display.
2. **Nexus Core** — prompt assembly, provider selection, memory retrieval and the tool-call loop.
3. **Tool registry** — named capabilities with JSON input schemas, validators, execution timeouts and permission boundaries.
4. **Agent Hub** — task coordination, leases, agent presence and SSE events.
5. **Providers** — local Ollama plus optional configured cloud/CLI providers.
6. **Specialist agents** — future workers registered by explicit skill/capability declarations; Nexus must select only workers that are actually connected and qualified.
7. **Storage** — browser memory for the current chat UI and Hub state/workspace for the local runtime. Hosted multi-user storage is not yet implemented.

## Implemented in the independent-core branch

- A model can request a tool using the explicit JSON protocol:
  - `{"type":"tool_call","name":"web_search","arguments":{"query":"..."}}`
  - `{"type":"final","text":"..."}`
- The loop executes at most four tool calls per user turn.
- Only tools explicitly marked `modelCallable: true`, read-only, non-destructive and permission-free are exposed to model-driven execution.
- The initial model-callable tools are `web_search` and `get_weather`.
- Default filesystem writes, shell commands, installers and Git mutations are not exposed to model-driven execution.
- The conversation transcript is shown as user/assistant messages and persisted in the current browser's local storage (last 100 messages).
- Orchestrated web/weather operations are not repeated by the agent tool loop after the outer workflow has already completed them.
- Unit tests cover the tool-call protocol, safe capability filtering and use of tool results.

These changes are on a feature branch and have not been merged into `main` or deployed.

## Important limitations — do not claim these are complete

- The team queue and presence model exist, but the full autonomous specialist-agent execution and independent reviewer are not yet wired end-to-end.
- Technical SEO crawling, PageSpeed/Lighthouse, Search Console, GA4, backlink intelligence and Google Business Profile integrations still need dedicated implementations and, where required, OAuth or a third-party data provider.
- A working local chat is not a public hosted service. Browser history is local to that browser and is not a multi-device account history.
- The image generation bridge exists in the repository, but an actual production GPU render has not been verified.
- No production hosting, login system, hosted database or public deployment has been completed.

## Security gate before public hosting

The current Agent Hub binds to loopback by default (`127.0.0.1:8788`). The HTTP server does not yet have a complete user authentication/session layer for its private APIs. Do not expose it publicly or change the bind address to `0.0.0.0` until all of the following are implemented and tested:

- authenticated user sessions and authorization on every private API route;
- server-side secret storage (never place provider API keys in `VITE_*` browser variables);
- strict production CORS/origin policy and rate limits;
- isolated per-user workspaces and persistent database access controls;
- SSRF-resistant URL fetching for future crawler/browser tools;
- audit logs and explicit user approval for destructive operations.

## Development checks

From the repository root:

```sh
npm ci
npm run build
npm run test:agent
npm run test:hub
npm run test:image
npm run test:image-hub
```

## Delivery sequence

1. Finish and test the independent chat/tool runtime.
2. Add authenticated sessions, user isolation and a production-safe API gateway.
3. Implement the agent team planner and actual worker execution: capability matching, dependency-aware parallel subtasks, leases, retries and independent review.
4. Add verified tool verticals in stages: safe site crawler and technical SEO, PageSpeed, content/AEO, analytics OAuth, backlink provider and local SEO.
5. Add document/data export and media tools behind the same capability registry.
6. Only then choose a hosting target and deploy a separate Nexus environment. No paid plan or resource may be provisioned without the user's explicit approval.
