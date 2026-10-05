# Nexus AI — Claude Code instructions

Read `docs/NEXUS-HANDOFF.md` (or `NEXUS_HANDOFF.md` if the docs copy is not present) before making architectural changes.

## Session protocol

For substantial multi-step tasks, invoke the `task-observer` skill and follow its Session Start Protocol. Check its observation log for relevant open observations. If the optional skill is unavailable, report that and continue using the existing task tracking rather than blocking work.

## Tooling stack

- Claude Code is an additional development agent, not a replacement for Nexus runtime, Copilot, Floot or Agent Hub.
- OmniRoute is optional. Start it with `scripts/start-omniroute-local.*`, never a bare `omniroute` command (its upstream default may bind all interfaces). Its absence must not block Nexus startup.
- Headroom may compress large tool outputs/context. Preserve raw source files and never treat compressed output as the only copy of important data.
- claude-setup provides optional development workflows. Use only commands actually listed by the installed plugin; do not assume slash commands exist.
- Keep authentication tokens and provider credentials outside Git. Never write secrets into tracked files.

## Nexus engineering rules

- Preserve the existing provider fallbacks and explicit user consent boundaries.
- Do not weaken Browser Bridge, payment, login, OTP, or destructive-action protections.
- Keep hosted Floot and local Agent Hub paths distinct.
- Prefer minimal, reversible changes and add tests for routing, memory, tools, media, or avatar behavior.
- Before declaring a coding task finished, run the relevant tests and `npm run build` when practical.
