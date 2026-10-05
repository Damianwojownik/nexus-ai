# Optional Claude development stack

Claude Code is an **additional development agent**. This tooling does not change
Nexus startup, provider selection, Floot, GPT-6 Luna, Agent Hub, Ollama, Browser
Bridge, ACE Music or avatar environments. No inference requests or production
deployment are performed by these scripts.

## Install

Use Node 22.22.2+ on the 22.x line, or Node 24/25/26. Node 18/20 and 23 are not
supported by the verified OmniRoute release. On Windows, use the BAT wrapper or
PowerShell; the wrapper's execution-policy override applies only to that process.

```powershell
.\scripts\setup-claude-tooling-windows.bat
.\scripts\setup-claude-tooling-windows.ps1 -DryRun
.\scripts\check-claude-stack.bat
```

```bash
bash scripts/setup-claude-tooling.sh
bash scripts/setup-claude-tooling.sh --dry-run
bash scripts/check-claude-stack.sh
```

Flags: `--skip-omniroute`, `--skip-headroom`, `--skip-plugins`,
`--skip-task-observer`, `--dry-run`; PowerShell equivalents are `-SkipOmniRoute`,
`-SkipHeadroom`, `-SkipPlugins`, `-SkipTaskObserver`, `-DryRun`.

The shared Node driver checks every command exit code, applies bounded timeouts
and preserves existing installations/registrations. Optional failures produce
WARN, not false PASS. Missing Claude/npm or unsupported Node produces FAIL and
exit 1. WARN alone does not block Nexus. Diagnostics do not print MCP configuration
or credentials. PATH includes the usual user npm and uv binary directories;
nonstandard installations must add their actual bin directories to PATH.

Verified installation commands (2026-10-04):

```text
npm install -g @anthropic-ai/claude-code@2.1.289
npm install -g omniroute@3.8.51
uv tool install --python 3.13 "headroom-ai[all]==0.39.1"
headroom mcp install --agent claude
claude plugin marketplace add nickmaglowsch/claude-setup
claude plugin install claude-setup@claude-setup --scope user
npx --yes skills@1.7.0 add rebelytics/one-skill-to-rule-them-all --skill task-observer --agent claude-code --global --copy --yes
```

Do not run all commands blindly over an existing installation; the installer
skips installed tools. Global user plugin/skill installation keeps these
third-party files out of Git. Run `claude plugin list --json` to inspect installed
plugins. If automatic installation fails, run the corresponding verified command
manually and inspect the error, or use Claude's interactive `/plugin` interface.
Do not use nonexistent `marketplace install`, `omniroute setup` or guessed commands.
The skill installer may contact its upstream registry; no project source is sent
by these scripts.

Install uv separately using its [official instructions](https://docs.astral.sh/uv/getting-started/installation/)
if absent. Headroom uses an isolated uv tool environment; there is deliberately
no pip fallback that changes Nexus/avatar/system Python packages. Python >=3.10
is required by Headroom; this setup selects Python 3.13.

## Loopback-only OmniRoute

Start separately from Nexus in another terminal:

```powershell
.\scripts\start-omniroute-local.ps1
```

```bash
bash scripts/start-omniroute-local.sh
```

The launcher forces `OMNIROUTE_SERVER_HOST=127.0.0.1`, `HOSTNAME=127.0.0.1` and
port 20128 for API/dashboard, rejects an occupied port and runs in the foreground.
Readiness retries for up to 60 seconds because first-run migrations and upstream
catalog initialization may delay HTTP responses even after the server says ready.
Do not launch bare `omniroute`: upstream defaults may listen on `0.0.0.0`.
Do not enable tunnels, LAN exposure or public forwarding in the dashboard.
Use `http://127.0.0.1:20128`. Health checks use `GET /api/health`, a three-second
timeout, no redirects and require JSON `status: "ok"`. Stop with Ctrl+C.
Offline health is WARN; there is no dependency from `npm run dev`/`npm run hub`.

The installer registers the supported **stdio** transport, without credentials.
This avoids the HTTP endpoint's management authentication/OAuth registration
requirements. On Windows it uses `cmd.exe` to execute the npm shim:

```text
claude mcp add omniroute --transport stdio --scope user --env OMNIROUTE_BASE_URL=http://127.0.0.1:20128 -- cmd.exe /d /s /c omniroute.cmd --mcp
```

On Linux/macOS/WSL:

```text
claude mcp add omniroute --transport stdio --scope user --env OMNIROUTE_BASE_URL=http://127.0.0.1:20128 -- omniroute --mcp
```

User scope makes the registration available from both this checkout and the
existing Nexus worktree, without writing a tracked `.mcp.json`.
Registration is not proof of connection: `claude mcp list` checks the actual stdio
handshake without invoking tools or inference. Tool calls that route inference
still need a configured provider; provider setup remains manual.
If you choose HTTP instead, `/api/mcp/stream` must be enabled with transport
`streamable-http` in OmniRoute and requires management authentication. Complete
authorization manually; never disable authentication to make diagnostics green.
Change the default dashboard password before configuring any provider.
An existing different registration is preserved and produces WARN.
Provider credentials/OAuth must be entered manually outside Git; no provider is
automatically activated and no billable model call is made.

## Headroom and Task Observer

Headroom installation **does not automatically enable hooks or a proxy**. First
inspect `headroom --version`, `headroom doctor` and `headroom init claude --help`.
It registers the optional stdio compression/retrieval MCP tools only for Claude
using `headroom mcp install --agent claude`; existing registrations are preserved.
The installed version supports on-demand `headroom_compress` and
`headroom_retrieve` locally, **without a proxy or model API call**. The original
is retained in the MCP session store and can be retrieved by hash. Session
storage is temporary, not a replacement for durable source files.
No Nexus provider config needs to change for these tools. For optional automatic
traffic compression, start `headroom proxy --host 127.0.0.1 --port 8787` and opt in
only the desired Claude process. `headroom doctor` reports an offline proxy if
you use only on-demand MCP; that is not an installation failure.
Before opting in with `headroom init claude`, back up affected Claude settings
outside the repository and review the generated changes. Do not override Nexus
provider settings. Compression must operate on a derived context/tool-output
copy: preserve original files, complete logs and source data; verify important
facts against originals. Headroom absence must never prevent development.

For a large Claude task, explicitly request:

> Use task-observer and follow its Session Start Protocol before implementation;
> review open observations, track progress and record the result at the end.

Check for `~/.claude/skills/task-observer/SKILL.md` (or the project equivalent).
This skill is for Claude, not a mandatory replacement for other agents' tracking.

## Authentication, validation and rollback

Run `claude` interactively to complete Anthropic login/subscription or your chosen
approved provider configuration. Installation/version checks do not prove login.
Diagnostics do not invoke `claude -p` or paid inference. Store secrets only in
user-local credential/config stores; never commit `.env`, OAuth tokens or MCP
headers. Installation cannot complete interactive authentication on your behalf.

```text
npm install
npm run build
npm run test:tooling
node scripts/check-headroom-compression.mjs
npm run test:hub
npm run test:image
npm run test:image-hub
```

Rollback code with `git revert <tooling-fix-commit>` on this PR branch. Tool
installation is outside Git: remove only tools added by this setup using
`npm uninstall -g omniroute`, `uv tool uninstall headroom-ai`,
`claude plugin uninstall claude-setup@claude-setup --scope user` and
`npx --yes skills@1.7.0 remove task-observer --global --agent claude-code --yes`.
Remove only the added user MCP registration with `claude mcp remove --scope user
omniroute`. Do not uninstall a previously installed Claude or other tools.
For only the added Headroom registration use
`claude mcp remove --scope user headroom`; do not remove a pre-existing registration.
Restore your own settings backup if you manually enabled Headroom.

## Sources

- [Claude npm metadata](https://www.npmjs.com/package/@anthropic-ai/claude-code) and installed CLI help.
- [OmniRoute](https://github.com/diegosouzapw/OmniRoute), including `bin/cli/utils/serverHost.mjs`,
  `bin/cli/commands/serve.mjs`, `/api/health` and `/api/mcp/stream`.
- [Headroom](https://github.com/headroomlabs-ai/headroom) and [PyPI metadata](https://pypi.org/project/headroom-ai/).
- [claude-setup marketplace](https://github.com/nickmaglowsch/claude-setup/blob/main/.claude-plugin/marketplace.json).
- [Task Observer](https://github.com/rebelytics/one-skill-to-rule-them-all) and `skills --help`.
