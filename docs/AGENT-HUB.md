# Nexus Agent Hub

Nexus uses GitHub as the shared source of truth for code while agents may execute in different environments. Nexus owns durable memory and coordination state; models and agents are replaceable workers.

In `AUTO` mode the model router uses a configured cloud primary when one actually exists, and falls back to local Ollama when that primary is unavailable or quota-limited. Memory belongs to Nexus rather than to the provider, so the same retrieved context is passed to the fallback model. The UI must not label Ollama as a cloud/primary connection.

## Runtime API

`createAgentHubServer(hub)` in `helpers/agentHubServer.ts` creates a Node HTTP server around the existing `AgentHub`. Run the local host from the repository root with:

```powershell
node --experimental-strip-types helpers/agentHubRuntime.ts
```

The runtime binds to `127.0.0.1:8788` by default and persists state under `%LOCALAPPDATA%/NexusAI`. The imported-file workspace is `%LOCALAPPDATA%/NexusAI/workspace` by default.
Set `NEXUS_AGENT_HUB_HOST`, `NEXUS_AGENT_HUB_PORT`, `NEXUS_AGENT_HUB_STATE`, `NEXUS_WORKSPACE_DIR` or comma-separated `NEXUS_AGENT_HUB_ALLOWED_ORIGINS` to override those defaults. The browser client uses `http://127.0.0.1:8788`; set `VITE_NEXUS_AGENT_HUB_URL` in `.env.local` to use another host.

The UI registers the actual `nexus-ui` agent, heartbeats it every 15 seconds, fetches agents/tasks from the API, and consumes new events over SSE. Native reconnect is not assumed: the client retries with bounded exponential backoff. The server allows local browser origins and HTTPS `*.sandbox.floot.app` origins, including Private Network Access preflight. Keep the service on loopback unless authentication and an explicit origin policy are added.

- `GET /api/health` reports server health.
- `GET` and `POST /api/agents` list and register agents; `POST /api/agents/:id/heartbeat` updates presence.
- `GET` and `POST /api/tasks` list and submit tasks; `GET /api/tasks/:id` reads a task.
- `POST /api/tasks/:id/claim` and `/lease` claim or lease work.
- `GET /api/events` returns recent events as JSON. With `Accept: text/event-stream`, it streams new events over SSE.
- `GET /api/search?q=...` performs DuckDuckGo web search and returns source URLs/snippets.
- `GET /api/weather?q=...` resolves a place and fetches current conditions plus a short forecast from Open-Meteo. Weather requests are routed here before the model answers, so the local Ollama fallback can answer from live data instead of guessing.
- `POST /api/workspace/import` stores one file up to 10 MB in the configured workspace; path segments and executable/installer extensions are rejected, and existing files are not overwritten.
- `GET /api/install/catalog`, `POST /api/install` and `GET /api/install/:id` expose the Windows `winget` allowlist and asynchronous operation status. Every start requires `confirmed: true`, and the endpoint rejects browser origins other than loopback. No arbitrary package IDs or shell commands are accepted.

The browser exposes search, import and install controls. Installation is disabled when `winget` is missing; the runtime will not install the package manager or another app without the individual UI confirmation. This machine currently has no `winget`, so installation execution is not verified. Search and workspace import have been exercised against the live local runtime.

The hub persists its task, agent and recent-event snapshot through its configured state file. Task leases prevent a second agent from claiming work while the current lease is active.

## Coordination contract

Each work item has an owner, status, scope and touched paths. Statuses: TODO, WORKING, BLOCKED, DONE. Agents claim work before editing, avoid overlapping paths, and push completed stages for review.

The local Vite UI has been verified in a real browser against the running Hub: it registers `nexus-ui`, displays real presence/tasks, submits/claims/leases work, renders SSE events, and shows CONNECTED, DISCONNECTED and ERROR/recovery states. The client integration test also drops active SSE connections, verifies automatic reconnect, and receives a subsequent event. Keep the hosted Floot deployment separate until its runtime URL and local-network access are configured there; do not infer hosted deployment success from local verification.
