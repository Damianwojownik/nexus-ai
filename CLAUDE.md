# Nexus AI — Claude Code instructions

Read `docs/NEXUS-HANDOFF.md` (or `NEXUS_HANDOFF.md` if the docs copy is not present) before making architectural changes.

## Session protocol

At the start of every task-oriented session where tools will be used or deliverables will be produced, invoke the `task-observer` skill and run its Session Start Protocol before the first substantive tool call. Check its observation log for open observations relevant to the current work.

## Tooling stack

- Claude Code is the primary coding agent for this workspace.
- OmniRoute may be used as the local routing/gateway layer when it is running on `127.0.0.1:20128`.
- Headroom may compress large tool outputs/context. Preserve raw source files and never treat compressed output as the only copy of important data.
- claude-setup provides build/debug/refactor/QA/review workflows. Prefer those workflows for substantial engineering changes.
- Keep authentication tokens and provider credentials outside Git. Never write secrets into tracked files.

## Nexus engineering rules

- Preserve the existing provider fallbacks and explicit user consent boundaries.
- Do not weaken Browser Bridge, payment, login, OTP, or destructive-action protections.
- Keep hosted Floot and local Agent Hub paths distinct.
- Prefer minimal, reversible changes and add tests for routing, memory, tools, media, or avatar behavior.
- Before declaring a coding task finished, run the relevant tests and `npm run build` when practical.
