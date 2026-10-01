# Nexus Agent Hub

Nexus uses GitHub as the shared source of truth for code while agents may execute in different environments. Nexus owns durable memory and coordination state; models and agents are replaceable workers.

## Runtime API

`createAgentHubServer(hub)` in `helpers/agentHubServer.ts` creates a Node HTTP server around the existing `AgentHub`. The host must bind and run the returned server; this repository does not yet mount it in the app runtime.

- `GET /api/health` reports server health.
- `GET` and `POST /api/agents` list and register agents; `POST /api/agents/:id/heartbeat` updates presence.
- `GET` and `POST /api/tasks` list and submit tasks; `GET /api/tasks/:id` reads a task.
- `POST /api/tasks/:id/claim` and `/lease` claim or lease work.
- `GET /api/events` returns recent events as JSON. With `Accept: text/event-stream`, it streams new events over SSE.

The hub persists its task, agent and recent-event snapshot through its configured state file. Task leases prevent a second agent from claiming work while the current lease is active.

## Coordination contract

Each work item has an owner, status, scope and touched paths. Statuses: TODO, WORKING, BLOCKED, DONE. Agents claim work before editing, avoid overlapping paths, and push completed stages for review.

The app UI is not yet connected to this API: agent count and hub activity are not currently driven by server presence or SSE events. The next task is to mount the server and wire the UI to presence, task lifecycle and live events.
