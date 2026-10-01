# Nexus AI

Snapshot of the existing Nexus project from Floot.

Floot project ID: `155877bd-a916-4527-8a1f-63d8e09ecf79`

## Current state

The UI, voice input, browser TTS, avatar selector and Floot agent scaffold already exist. The main UI action is still mocked and must not be described as a working AI conversation yet.

This repository is the shared source bridge for VS Code/Codex work. Floot-specific source is preserved under its original virtual paths.

## Next task

Integrate Ollama as the local AI provider behind a provider/router abstraction, preserving the current Nexus UI. See `docs/FLOOT-SNAPSHOT.md`.
