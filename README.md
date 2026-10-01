# Nexus AI

Snapshot of the existing Nexus project from Floot.

Floot project ID: `155877bd-a916-4527-8a1f-63d8e09ecf79`

## Current state

The existing conversation UI routes prompts through `NexusAgent`, `ModelRouter` and the local Ollama provider. Voice input, browser TTS and avatar selection remain in place. The Nexus UI now uses a real Agent Hub HTTP/SSE client for agent presence, task submission/claim/lease, task lists and live events. The hub server runs as a separate local process; final verification in the hosted app is still in progress.

This repository is the shared source bridge for VS Code/Codex work. Floot-specific source is preserved under its original virtual paths.

## Next task

Run the local Agent Hub runtime and verify the hosted Nexus UI connects, receives real agent presence and live SSE updates. See `docs/AGENT-HUB.md`.
