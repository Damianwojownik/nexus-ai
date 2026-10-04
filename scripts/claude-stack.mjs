import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';

export const versions = { claude: '2.1.289', omniroute: '3.8.51', headroom: '0.39.1', skills: '1.7.0' };
export const endpoint = 'http://127.0.0.1:20128';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = homedir();
const win = process.platform === 'win32';
const flags = new Set(process.argv.slice(3));
const localBins = [join(home, '.local', 'bin')];
if (win && process.env.APPDATA) localBins.push(join(process.env.APPDATA, 'npm'));
process.env.PATH = [...localBins, process.env.PATH || ''].join(delimiter);

export function supportedNode(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return (major === 22 && (minor > 22 || (minor === 22 && patch >= 2)))
    || (major >= 24 && major < 27);
}

export function run(command, args = [], options = {}) {
  let executable = command;
  let arguments_ = args;
  let windowsVerbatimArguments = false;
  // npm's Windows shims cannot be executed directly by execFile/spawn.
  if (win && ['npm', 'npx', 'claude', 'omniroute'].includes(command)) {
    if ([command, ...args].some(value => /["%!\r\n&|<>^]/.test(value))) {
      throw new Error('Unsafe Windows command argument');
    }
    executable = process.env.ComSpec || 'cmd.exe';
    arguments_ = ['/d', '/s', '/c', `${command}.cmd ${args.map(value => `"${value}"`).join(' ')}`];
    windowsVerbatimArguments = true;
  }
  const result = spawnSync(executable, arguments_, {
    cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true,
    maxBuffer: 4 * 1024 * 1024, windowsVerbatimArguments, ...options,
  });
  return { ok: !result.error && result.status === 0, ...result };
}

function message(status, label, detail) {
  console.log(`${status} ${label}: ${detail}`);
}

function requireRun(command, args, options) {
  const result = run(command, args, options);
  if (!result.ok) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.error?.code || result.status}); run this command manually to inspect its output.`);
  }
  return result;
}

export async function health(url = endpoint, fetcher = fetch) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '20128') {
    throw new Error('OmniRoute must use the fixed loopback endpoint');
  }
  const response = await fetcher(`${url}/api/health`, {
    signal: AbortSignal.timeout(3000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`health HTTP ${response.status}`);
  const body = await response.json();
  if (body.status !== 'ok') throw new Error('Unexpected health response');
  return true;
}

export function mcpRegistered(text) {
  const command = text.match(/^\s*Command:\s*(cmd\.exe|omniroute)\s*$/m)?.[1];
  const args = text.match(/^\s*Args:\s*(.+)$/m)?.[1]?.trim();
  return /Type:\s*stdio/i.test(text)
    && text.includes(`OMNIROUTE_BASE_URL=${endpoint}`)
    && ((command === 'cmd.exe' && args === '/d /s /c omniroute.cmd --mcp')
      || (command === 'omniroute' && args === '--mcp'));
}

export function mcpRegistrationArguments() {
  return ['mcp', 'add', 'omniroute', '--transport', 'stdio', '--scope', 'user',
    '--env', `OMNIROUTE_BASE_URL=${endpoint}`, '--',
    ...(win ? ['cmd.exe', '/d', '/s', '/c', 'omniroute.cmd', '--mcp'] : ['omniroute', '--mcp'])];
}

export function observerPresent() {
  return [
    join(root, '.claude', 'skills', 'task-observer', 'SKILL.md'),
    join(home, '.claude', 'skills', 'task-observer', 'SKILL.md'),
  ].some(existsSync);
}

function jsonCommand(args) {
  const result = run('claude', args);
  if (!result.ok) return null;
  try { return JSON.parse(result.stdout); }
  catch { message('WARN', 'Claude metadata', 'Invalid JSON; inspect the CLI manually.'); return null; }
}

export async function check() {
  let failed = !supportedNode(process.versions.node);
  message(failed ? 'FAIL' : 'PASS', 'Node', process.versions.node);
  for (const [command, required] of [['npm', true], ['claude', true], ['omniroute', false], ['headroom', false], ['uv', false]]) {
    const result = run(command, ['--version']);
    message(result.ok ? 'PASS' : required ? 'FAIL' : 'WARN', command,
      result.ok ? result.stdout.trim().split('\n')[0] : 'Missing, failed or timed out; check PATH.');
    if (required && !result.ok) failed = true;
  }
  const python = ['python3', 'python', ...(win ? ['py'] : [])]
    .find(command => run(command, ['--version']).ok);
  message(python ? 'PASS' : 'WARN', 'Python', python
    ? run(python, ['--version']).stdout.trim()
    : 'Not found; Headroom needs Python >=3.10 / uv.');
  const authentication = jsonCommand(['auth', 'status']);
  message(authentication?.loggedIn ? 'PASS' : 'WARN', 'Claude login',
    authentication?.loggedIn ? 'Authenticated (no model call performed).' : 'Interactive login is still required.');
  message(observerPresent() ? 'PASS' : 'WARN', 'Task Observer',
    observerPresent() ? 'SKILL.md is available to Claude Code.' : 'Not installed in project/user Claude skills.');
  const plugins = jsonCommand(['plugin', 'list', '--json']);
  const installed = Array.isArray(plugins) && plugins.some(p => p.id === 'claude-setup@claude-setup' && p.enabled);
  message(installed ? 'PASS' : 'WARN', 'claude-setup', installed ? 'Enabled plugin.' : 'Not enabled; see manual install in docs.');
  const mcp = run('claude', ['mcp', 'get', 'omniroute']);
  message(mcpRegistered(mcp.stdout || '') ? 'PASS' : 'WARN',
    'MCP registration', 'Expected local stdio OmniRoute; credentials/config contents are not printed.');
  const connections = run('claude', ['mcp', 'list'], { timeout: 45000 });
  const connected = connections.ok && /omniroute.*(?:Connected|✓)/i.test(connections.stdout);
  message(connected ? 'PASS' : 'WARN', 'MCP connection', connected ? 'OmniRoute connected.' : 'Not connected or timed out; optional, Nexus remains independent.');
  const headroomConnected = connections.ok && /headroom.*(?:Connected|✓)/i.test(connections.stdout);
  message(headroomConnected ? 'PASS' : 'WARN', 'Headroom MCP',
    headroomConnected ? 'Optional compression/retrieval tools connected.' : 'Not connected; optional, no provider settings changed.');
  try { await health(); message('PASS', 'OmniRoute health', '/api/health returned status ok.'); }
  catch (error) { message('WARN', 'OmniRoute health', `${error.message}; Nexus startup is not blocked.`); }
  return failed ? 1 : 0;
}

function install(command, args, label, dry) {
  if (dry) { message('PASS', `PLAN ${label}`, `${command} ${args.join(' ')}`); return; }
  requireRun(command, args, { timeout: 900000, stdio: 'inherit' });
  message('PASS', label, 'Command completed.');
}

export async function setup() {
  const allowed = ['--skip-headroom', '--skip-omniroute', '--skip-plugins', '--skip-task-observer', '--dry-run'];
  for (const flag of flags) if (!allowed.includes(flag)) throw new Error(`Unknown option: ${flag}`);
  if (!supportedNode(process.versions.node)) throw new Error('Use Node 22.22.2+, or 24/25/26; Node 18 is no longer sufficient.');
  requireRun('npm', ['--version']);
  const dry = flags.has('--dry-run');
  const optional = (label, action) => {
    try { action(); }
    catch (error) { message('WARN', label, error.message); }
  };
  if (!run('claude', ['--version']).ok) install('npm', ['install', '-g', `@anthropic-ai/claude-code@${versions.claude}`], 'Claude Code', dry);
  else message('PASS', 'Claude Code', 'Existing CLI preserved; no forced global upgrade.');
  if (!flags.has('--skip-omniroute')) optional('OmniRoute', () => {
    if (!run('omniroute', ['--version']).ok) install('npm', ['install', '-g', `omniroute@${versions.omniroute}`], 'OmniRoute', dry);
    else message('PASS', 'OmniRoute', 'Existing installation preserved.');
    const existing = run('claude', ['mcp', 'get', 'omniroute']);
    if (existing.error && !dry) throw new Error('MCP inventory failed or timed out; existing registration was not changed.');
    // get may exit nonzero for a registered but disconnected server.
    if (/Type:\s*(stdio|http|sse)/i.test(existing.stdout || '')) {
      if (!mcpRegistered(existing.stdout)) throw new Error('Existing omniroute MCP differs; preserved. Resolve manually, do not overwrite.');
      message('PASS', 'MCP', 'Existing local stdio registration preserved.');
    } else install('claude', mcpRegistrationArguments(), 'MCP', dry);
  });
  if (!flags.has('--skip-plugins')) optional('claude-setup', () => {
    const marketplaces = jsonCommand(['plugin', 'marketplace', 'list', '--json']);
    if (!Array.isArray(marketplaces) || !marketplaces.some(p => p.name === 'claude-setup')) {
      install('claude', ['plugin', 'marketplace', 'add', 'nickmaglowsch/claude-setup'], 'Marketplace', dry);
    }
    const plugins = jsonCommand(['plugin', 'list', '--json']);
    if (Array.isArray(plugins) && plugins.some(p => p.id === 'claude-setup@claude-setup')) {
      message('PASS', 'claude-setup', 'Existing plugin preserved; enable it manually if disabled.');
    } else install('claude', ['plugin', 'install', 'claude-setup@claude-setup', '--scope', 'user'], 'claude-setup', dry);
  });
  if (!flags.has('--skip-headroom')) optional('Headroom', () => {
    if (run('headroom', ['--version']).ok) message('PASS', 'Headroom', 'Existing tool preserved.');
    else {
      if (!run('uv', ['--version']).ok) throw new Error('uv missing. Install uv manually, then rerun; no pip changes to Nexus/avatar environments.');
      install('uv', ['tool', 'install', '--python', '3.13', `headroom-ai[all]==${versions.headroom}`], 'Headroom', dry);
    }
    install('headroom', ['mcp', 'install', '--agent', 'claude'], 'Headroom MCP', dry);
    message('WARN', 'Headroom hooks', 'Not auto-enabled. Review headroom init claude --help, back up local settings, then opt in. Original source files must remain untouched.');
  });
  if (!flags.has('--skip-task-observer')) optional('Task Observer', () => {
    if (observerPresent()) { message('PASS', 'Task Observer', 'Existing skill preserved.'); return; }
    install('npx', ['--yes', `skills@${versions.skills}`, 'add', 'rebelytics/one-skill-to-rule-them-all',
      '--skill', 'task-observer', '--agent', 'claude-code', '--global', '--copy', '--yes'], 'Task Observer', dry);
  });
  message('WARN', 'Authentication', 'Run claude interactively to log in. Provider login is manual in OmniRoute; no inference or paid operation was requested.');
  return dry ? 0 : check();
}

export function routeEnvironment(env) {
  return { ...env, OMNIROUTE_SERVER_HOST: '127.0.0.1', HOSTNAME: '127.0.0.1',
    PORT: '20128', API_PORT: '20128', DASHBOARD_PORT: '20128',
    OMNIROUTE_BASE_URL: endpoint };
}

async function route() {
  requireRun('omniroute', ['--version']);
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(20128, '127.0.0.1', resolve);
  });
  await new Promise(resolve => probe.close(resolve));
  const env = routeEnvironment(process.env);
  const child = win
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'omniroute.cmd serve --port 20128 --no-open --no-tray --no-recovery --log'], { env, stdio: 'inherit', cwd: home, windowsVerbatimArguments: true })
    : spawn('omniroute', ['serve', '--port', '20128', '--no-open', '--no-tray', '--no-recovery', '--log'], { env, stdio: 'inherit', cwd: home });
  child.on('error', error => { message('FAIL', 'OmniRoute', error.message); process.exitCode = 1; });
  let stopped = false;
  child.on('exit', code => { stopped = true; process.exitCode = code ?? 1; });
  const deadline = Date.now() + 60000;
  let lastError;
  while (!stopped && Date.now() < deadline) {
    try { await health(); message('PASS', 'OmniRoute health', 'Loopback gateway responds.'); return; }
    catch (error) { lastError = error; }
    if (!stopped) await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!stopped) message('WARN', 'OmniRoute health', `Not ready after 60s: ${lastError?.message}`);
}

async function main() {
  const action = process.argv[2];
  if (action === 'setup') process.exitCode = await setup();
  else if (action === 'check') process.exitCode = await check();
  else if (action === 'route') await route();
  else throw new Error('Use setup, check or route');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { message('FAIL', 'Claude stack', error.message); process.exitCode = 1; });
}
