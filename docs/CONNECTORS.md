# Nexus external connectors

Nexus treats external applications as replaceable tools behind the Agent Hub. The user still talks to one Nexus interface; GitHub, Canva-class services and future MCP-compatible apps stay behind the orchestrator.

## Built-in GitHub connector

When GitHub CLI (`gh`) is installed and authenticated, Agent Hub automatically exposes a read-only GitHub connector.

Health:

```http
GET /api/connectors
```

Tools:

```http
GET /api/connectors/github/tools
```

Built-in tools are deliberately read-only:
- `repo_view`
- `read_file`
- `search_repositories`

Nexus does not copy the GitHub token into browser code. Authentication remains owned by `gh auth` on the local machine.

## MCP-compatible apps

Additional services can be declared with `NEXUS_CONNECTORS_JSON`. Secrets are referenced by environment-variable name and are never embedded in the connector manifest.

Example PowerShell setup:

```powershell
$connectors = @'
[
  {
    "id": "my-app",
    "name": "My App",
    "transport": "mcp-http",
    "url": "https://official-provider.example/mcp",
    "tokenEnv": "NEXUS_MY_APP_TOKEN"
  }
]
'@

[Environment]::SetEnvironmentVariable("NEXUS_CONNECTORS_JSON", $connectors, "User")
[Environment]::SetEnvironmentVariable("NEXUS_MY_APP_TOKEN", "<token-from-provider>", "User")
```

Use only an official connector/MCP endpoint supplied by the service. Do not guess Canva or another provider's endpoint. If Canva exposes an official MCP/OAuth endpoint for the account, add it with the same manifest shape.

## Safety model

- Remote connector URLs must use HTTPS. Plain HTTP is accepted only for localhost/127.0.0.1.
- URLs containing embedded usernames/passwords are rejected.
- Connector tokens stay server-side in environment variables.
- Tool discovery and health checks do not return tokens.
- MCP tools annotated `readOnlyHint: true` can run without a destructive-action approval.
- Write/unknown MCP tools require `confirmed: true`.
- POST connector actions are available only from the local Nexus frontend, not a remote Floot origin.

## API

List connector health:

```http
GET /api/connectors
```

List tools:

```http
GET /api/connectors/:id/tools
```

Invoke a tool:

```http
POST /api/connectors/:id/call
Content-Type: application/json

{
  "tool": "tool_name",
  "args": {},
  "confirmed": false
}
```

For write/unknown MCP actions the Hub rejects the call until `confirmed` is true.

## Design invariant

Connectors are tools, not memory owners and not model providers. Nexus memory stays provider-independent, so switching from Copilot/Codex/cloud providers to local Ollama does not erase project or conversation state.
