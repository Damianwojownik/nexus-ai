import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConnectorManifests } from './connectorRegistry.ts';

test('accepts an HTTPS MCP connector with a server-side token reference', () => {
  const entries = parseConnectorManifests(JSON.stringify([{
    id: 'research-app',
    name: 'Research App',
    transport: 'mcp-http',
    url: 'https://mcp.researchapp.com/gateway',
    tokenEnv: 'NEXUS_RESEARCH_APP_TOKEN',
  }]));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'research-app');
  assert.equal(entries[0].tokenEnv, 'NEXUS_RESEARCH_APP_TOKEN');
  assert.equal(entries[0].enabled, true);
});

test('allows plain HTTP only for an explicit loopback connector', () => {
  const entries = parseConnectorManifests(JSON.stringify([{
    id: 'local-tool',
    name: 'Local Tool',
    transport: 'mcp-http',
    url: 'http://127.0.0.1:8790/mcp',
  }]));
  assert.equal(entries[0].url, 'http://127.0.0.1:8790/mcp');
  assert.throws(() => parseConnectorManifests(JSON.stringify([{
    id: 'remote-tool',
    name: 'Remote Tool',
    transport: 'mcp-http',
    url: 'http://mcp.researchapp.com/mcp',
  }])), /HTTPS/);
});

test('rejects literal IP addresses and reserved hostnames for remote connectors', () => {
  for (const url of [
    'https://192.168.1.20/mcp',
    'https://10.0.0.8/mcp',
    'https://127.0.0.1/mcp',
    'https://mcp.internal/mcp',
    'https://mcp.example/mcp',
    'https://service.local/mcp',
  ]) {
    assert.throws(() => parseConnectorManifests(JSON.stringify([{
      id: 'blocked-tool',
      name: 'Blocked Tool',
      transport: 'mcp-http',
      url,
    }])), /public DNS hostname|Loopback MCP connectors/);
  }
});

test('rejects embedded credentials and malformed connector manifests', () => {
  assert.throws(() => parseConnectorManifests(JSON.stringify([{
    id: 'credentialed',
    name: 'Credentialed',
    transport: 'mcp-http',
    url: 'https://user:password@mcp.researchapp.com/mcp',
  }])), /must not embed credentials/);
  assert.throws(() => parseConnectorManifests('{invalid'), /valid JSON/);
  assert.throws(() => parseConnectorManifests(JSON.stringify([
    { id: 'duplicate', name: 'One', transport: 'mcp-http', url: 'https://one.provider.com/mcp' },
    { id: 'duplicate', name: 'Two', transport: 'mcp-http', url: 'https://two.provider.com/mcp' },
  ])), /Duplicate connector id/);
});

test('rejects unknown transports, invalid IDs and unsafe token environment names', () => {
  assert.throws(() => parseConnectorManifests(JSON.stringify([{
    id: 'bad',
    name: 'Bad',
    transport: 'exec',
    url: 'https://mcp.researchapp.com/mcp',
  }])), /unsupported transport/);
  assert.throws(() => parseConnectorManifests(JSON.stringify([{
    id: '../bad',
    name: 'Bad',
    transport: 'mcp-http',
    url: 'https://mcp.researchapp.com/mcp',
  }])), /invalid id/);
  assert.throws(() => parseConnectorManifests(JSON.stringify([{
    id: 'bad-token',
    name: 'Bad Token',
    transport: 'mcp-http',
    url: 'https://mcp.researchapp.com/mcp',
    tokenEnv: 'NEXUS TOKEN',
  }])), /invalid tokenEnv/);
});
