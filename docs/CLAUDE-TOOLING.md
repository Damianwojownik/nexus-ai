# Claude tooling stack for Nexus AI

This branch adds a reproducible local developer stack around Claude Code.

## Installed by the bootstrap

1. **Claude Code** — official Anthropic CLI.
2. **OmniRoute** — local multi-provider gateway and MCP endpoint on port `20128`.
3. **Headroom** — context/tool-output compression and Claude hooks.
4. **claude-setup** — reusable Claude Code build/debug/refactor/QA workflows.
5. **Task Observer** — project skill that captures repeatable workflow improvements.

## Windows

Run from the repository root:

```powershell
scripts\setup-claude-tooling-windows.bat
```

The PowerShell implementation is in `scripts/setup-claude-tooling-windows.ps1`.

## macOS / Linux / WSL

```bash
bash scripts/setup-claude-tooling.sh
```

## Authentication

The bootstrap never stores credentials in Git.

After installation:

```bash
claude
```

Complete Claude authentication interactively.

For OmniRoute:

```bash
omniroute setup
omniroute
```

The gateway dashboard/API runs locally on port `20128`. The bootstrap registers its MCP endpoint in Claude Code at:

```text
http://127.0.0.1:20128/api/mcp/stream
```

## Verification

```bash
claude doctor
claude mcp list
omniroute doctor
headroom doctor
```

Task Observer should be visible under the project's Claude skills after installation. Its activation instruction is also present in the repository root `CLAUDE.md`.

## About ClipCache

`ClipCache` was not added to this bootstrap. The projects found under that name are desktop clipboard managers (macOS/Windows), not Claude Code plugins, and installing one would be an OS-level choice rather than a Nexus project dependency. If a specific Claude plugin named "Clip Cache" was intended, add its exact repository/name before installing it.

## Security notes

- Review third-party plugin code before trusting it with repository access.
- Keep provider/API credentials outside tracked files.
- OmniRoute and Headroom run locally; do not expose their local ports publicly without authentication.
- Project MCP configuration should not include secrets.
