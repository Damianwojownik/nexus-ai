import { join } from 'node:path';
import { AgentHub } from './agentHub.ts';
import { createAgentHubServer } from './agentHubServer.ts';

const port = Number(process.env.NEXUS_AGENT_HUB_PORT ?? 8788);
const host = process.env.NEXUS_AGENT_HUB_HOST ?? '127.0.0.1';
const stateFilePath = process.env.NEXUS_AGENT_HUB_STATE ?? join(process.cwd(), '.nexus-agent-state.json');
const allowedOrigins = (process.env.NEXUS_AGENT_HUB_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('NEXUS_AGENT_HUB_PORT must be a valid TCP port');
}

const hub = new AgentHub({ stateFilePath });
const server = createAgentHubServer(hub, { allowedOrigins });
server.listen(port, host, () => {
  console.log(`Nexus Agent Hub listening at http://${host}:${port}`);
});

const close = () => {
  server.closeAllConnections();
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
};

process.once('SIGINT', close);
process.once('SIGTERM', close);