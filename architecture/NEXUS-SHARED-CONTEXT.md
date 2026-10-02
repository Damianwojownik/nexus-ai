# Nexus Shared Context

This file is the durable handoff between Nexus, Codex and other coding agents. Keep it factual and update it when architecture decisions change.

## Product goal

Nexus is one conversational AI interface. The user should not need to choose separate tools for coding, web search, local models, cloud models, GitHub or project building. The orchestrator selects capabilities and reports only meaningful progress or required approvals.

## Runtime rules

- Prefer a configured remote provider in AUTO mode.
- If the remote provider is unavailable or runs out of quota, continue with local Ollama when healthy.
- Never claim current internet data without a successful live capability call.
- Web search is routed through the local Agent Hub.
- Weather is routed through Open-Meteo.
- Persist project memory through the Agent Hub so browser sessions and local agents can share context.
- Keep official ChatGPT/primary status separate from generic cloud-provider availability.

## Builder workflow

For a new application request:
1. Ask only for missing requirements.
2. Produce a concise project blueprint.
3. Ask for confirmation or accept corrections.
4. After confirmation, generate the complete starter project.
5. Write only validated project files inside the Nexus workspace.
6. Verify that the files were written.
7. Continue iterating on the same project from user feedback.

The builder must not write outside the workspace and must not generate executable installers or environment-secret files.

## Integrations

Integrations should be adapters with a health check and explicit capabilities. Credentials stay in the local/server environment, never in browser code or committed files. GitHub is the durable code/history handoff between agents.

## Avatar

Nexus and Luna are separate visual personas driven by the same AI/runtime. The long-term avatar goal is realistic realtime facial/body motion. Rigged GLB/GLTF/VRM assets are preferred; a static mesh requires rigging before full-body animation.
