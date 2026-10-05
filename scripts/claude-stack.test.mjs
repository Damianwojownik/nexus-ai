import test from 'node:test';
import assert from 'node:assert/strict';
import { supportedNode, routeEnvironment, health, run, endpoint, mcpRegistered, mcpRegistrationArguments } from './claude-stack.mjs';

test('Node compatibility matches pinned OmniRoute engine boundary', () => {
  for (const version of ['18.20.8', '20.19.0', '22.22.1', '23.0.0', '27.0.0']) {
    assert.equal(supportedNode(version), false, version);
  }
  for (const version of ['22.22.2', '22.23.0', '24.0.0', '25.0.0', '26.7.0']) {
    assert.equal(supportedNode(version), true, version);
  }
});

test('launcher overrides exposure variables without changing parent config', () => {
  const original = { OMNIROUTE_SERVER_HOST: '0.0.0.0', HOSTNAME: 'public', PORT: '80', KEEP: 'yes' };
  const env = routeEnvironment(original);
  assert.equal(env.OMNIROUTE_SERVER_HOST, '127.0.0.1');
  assert.equal(env.HOSTNAME, '127.0.0.1');
  for (const name of ['PORT', 'API_PORT', 'DASHBOARD_PORT']) assert.equal(env[name], '20128');
  assert.equal(env.KEEP, 'yes');
  assert.equal(original.PORT, '80');
});

test('health validates actual response shape and prevents redirected/public probes', async () => {
  await health(endpoint, async (url, options) => {
    assert.equal(url, `${endpoint}/api/health`);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    return Response.json({ status: 'ok' });
  });
  for (const url of ['http://0.0.0.0:20128', 'http://example.com', 'http://127.0.0.1:80', 'https://127.0.0.1:20128']) {
    await assert.rejects(health(url), /loopback/);
  }
  await assert.rejects(health(endpoint, async () => Response.json({ status: 'error' })), /Unexpected/);
  await assert.rejects(health(endpoint, async () => new Response('', { status: 503 })), /503/);
  await assert.rejects(health(endpoint, async () => { throw new Error('offline'); }), /offline/);
});

test('native nonzero exit and missing command cannot become success', () => {
  assert.equal(run(process.execPath, ['-e', 'process.exit(7)']).ok, false);
  assert.equal(run('nexus-no-such-command-12345').ok, false);
  assert.equal(run(process.execPath, ['--version']).ok, true);
});

test('bounded commands time out', () => {
  const result = run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeout: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ETIMEDOUT');
});

test('Windows shim arguments reject shell metacharacters', { skip: process.platform !== 'win32' }, () => {
  for (const value of ['x&echo bad', '%PATH%', 'x"bad', 'x|bad', 'x\nbad']) {
    assert.throws(() => run('npm', [value]), /Unsafe/);
  }
});

test('actual npm shim executes successfully on supported host', () => {
  const result = run('npm', ['--version']);
  assert.equal(result.ok, true, result.stderr);
  assert.match(result.stdout, /^\d+\.\d+\.\d+/);
});

test('registered but disconnected stdio MCP remains installed', () => {
  const env = `\nEnvironment:\n  OMNIROUTE_BASE_URL=${endpoint}\n`;
  assert.equal(mcpRegistered('Status: Failed to connect\nType: stdio\nCommand: cmd.exe\nArgs: /d /s /c omniroute.cmd --mcp\n' + env), true);
  assert.equal(mcpRegistered('Type: stdio\nCommand: omniroute\nArgs: --mcp\n' + env), true);
  assert.equal(mcpRegistered(`Type: http\nURL: ${endpoint}/api/mcp/stream`), false);
  assert.equal(mcpRegistered('No MCP server found'), false);
  assert.equal(mcpRegistered('Type: stdio\nCommand: unrelated\nArgs: --mcp\n'), false);
  assert.equal(mcpRegistered('Type: stdio\nCommand: cmd.exe\nArgs: /c unrelated --mcp\n' + env), false);
  assert.equal(mcpRegistered('Type: stdio\nCommand: omniroute\nArgs: --mcp\n'), false);
  const args = mcpRegistrationArguments();
  assert.ok(args.includes(`OMNIROUTE_BASE_URL=${endpoint}`));
  assert.ok(args.includes('--mcp'));
  assert.ok(args.includes('user'));
});
