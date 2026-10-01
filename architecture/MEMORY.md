# Nexus Memory

Nexus is the owner of memory. ChatGPT, Codex, Ollama and future models are consumers of selected context.

## Memory classes

- identity: stable Nexus configuration and persona settings
- user-approved preferences: interaction and project preferences
- projects: architecture, decisions, constraints, repositories and milestones
- tasks: goals, plans, ownership, status, outputs and blockers
- episodic summaries: compact summaries of completed work
- artifacts: references to files/commits/documents, not unnecessary duplicate blobs

## Retrieval

The orchestrator queries memory for the current goal and builds a bounded context packet. Each subagent receives the minimum relevant packet plus its task. This avoids sending the complete history to every model.

## Write path

Candidate memory -> validate/classify -> deduplicate -> persist -> index -> expose to retrieval.

Important decisions and task transitions are durable events. Provider chat history is not the source of truth.

## Safety and control

Memory access is scoped by agent/tool role. Secrets are not stored as ordinary memories. Destructive deletion or broad export must be explicit. The storage implementation remains replaceable so Nexus is not locked to one model vendor.
