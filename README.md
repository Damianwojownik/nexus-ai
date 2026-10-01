# Nexus AI

Snapshot of the existing Nexus project from Floot.

Floot project ID: `155877bd-a916-4527-8a1f-63d8e09ecf79`

## Current state

The existing conversation UI routes prompts through `NexusAgent`, `ModelRouter` and the local Ollama provider. Voice input, browser TTS and avatar selection remain in place. The agent hub now supports persisted coordination state and a Node HTTP/SSE server factory; that server is not yet mounted by the app runtime.

This repository is the shared source bridge for VS Code/Codex work. Floot-specific source is preserved under its original virtual paths.

## Next task

Mount the agent hub server in the app runtime and connect the UI to agent presence, task state and its SSE event stream. See `docs/AGENT-HUB.md`.
