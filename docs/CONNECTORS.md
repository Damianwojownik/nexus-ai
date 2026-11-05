# Optional Nexus connectors

Nexus can load external Model Context Protocol (MCP) services through its own Agent Hub. This is optional: Nexus chat, local Ollama and built-in local capabilities do not require any external MCP service.

## Add a connector

The local Agent Hub reads a JSON manifest from the server-side environment variable `NEXUS_CONNECTORS_JSON`.

Example manifest (replace the fictional hostname with the official HTTPS endpoint of a service you trust):

```json
[
  {
    "id": "example-research",
    "name": "Example Research",
    "transport": "mcp-http",
    "url": "https://mcp.example-provider.net/mcp",
    "tokenEnv": "NEXUS_EXAMPLE_RESEARCH_TOKEN",
    "enabled": true
  }
]
```

Set the bearer token in the Agent Hub process environment as `NEXUS_EXAMPLE_RESEARCH_TOKEN`. Do not put tokens in this JSON, a Vite `VITE_*` variable, browser local storage, source files, screenshots or logs. Do not commit real manifests or secrets.

An HTTP endpoint on loopback is supported only for local development, for example `http://127.0.0.1:8790/mcp`. Remote connectors must use HTTPS and a public DNS hostname. Connector requests reject HTTP redirects. The Agent Hub resolves the hostname and rejects private/reserved results before connecting; this is a defensive SSRF check, not a substitute for a hardened network boundary or pinned DNS/socket policy.

## Tool execution policy

- Nexus fetches the currently advertised tools and schemas; it does not invent tool names.
- The model's tool selection is a proposal, not authority. The server executes only a tool that exists in the connector's current catalog.
- Tools explicitly annotated read-only may run without a confirmation prompt.
- Write or unknown tools require a separate user confirmation in the Nexus UI.
- External tool descriptions and results are untrusted data. They must never override Nexus policies or authorize further actions.
- The current planner selects at most one external MCP tool for one user turn. Multi-step external tool loops are a later milestone.
- Do not connect providers you do not trust. A connector can see the data included in its tool call.

## Status

Use the **Integracje** section in Nexus settings to see connector health. A connector appears only when its environment manifest and required credentials are present and the service responds successfully.

## No Ezostylia dependency

This integration layer is provider-neutral. It has no built-in Ezostylia URL, token, connector ID, SDK, data model or required dependency. Keep Ezostylia separate and unchanged.
