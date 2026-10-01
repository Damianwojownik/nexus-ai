# Nexus Agent Hub

Nexus uses GitHub as the shared source-of-truth for code while agents may execute in different environments.

## Coordination contract

Each work item has an owner, status, scope and touched paths.

Statuses: TODO, WORKING, BLOCKED, DONE.

Agents should claim a task before editing, avoid overlapping paths, commit coherent stages, and push completed stages so other agents can review them.

## Current split

- Codex: Ollama local provider, bridge, model router integration, tests.
- ChatGPT: Floot source synchronization, shared architecture documentation, review/integration.
- Nexus: future coordinator that will assign tasks and synchronize state through an API/WebSocket layer.

Git remains the durable code/history layer. Real-time presence and task state will be implemented separately; GitHub alone is not a real-time agent bus.
