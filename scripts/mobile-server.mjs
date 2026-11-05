import { createServer, request as nodeRequest } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = resolve(root, '.nexus-build');
const host = '127.0.0.1'; // Private by default. HTTPS exposure must use a trusted tailnet.
const port = Number(process.env.NEXUS_MOBILE_PORT ?? 5190);
const hubPort = Number(process.env.NEXUS_AGENT_HUB_PORT ?? 8789);
const ollamaUrl = new URL(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434');
const hubUrl = new URL('http://127.0.0.1:' + hubPort);
const pairingCode = randomBytes(8).toString('base64url');
const session = randomBytes(32).toString('hex');
let attempts = 0;
let attemptsReset = Date.now() + 10 * 60_000;

if (![port, hubPort].every(value => Number.isInteger(value) && value > 0 && value <= 65535)) {
  throw new Error('Invalid NEXUS_MOBILE_PORT or NEXUS_AGENT_HUB_PORT');
}
if (!['localhost', '127.0.0.1'].includes(ollamaUrl.hostname)) {
  throw new Error('Mobile gateway only proxies a loopback Ollama instance');
}

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.webp', 'image/webp'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.woff2', 'font/woff2'], ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'], ['.mp3', 'audio/mpeg'],
]);

function send(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body);
}

function authenticated(request) {
  const cookie = request.headers.cookie?.match(/(?:^|;\s*)luna_mobile=([0-9a-f]{64})(?:;|$)/)?.[1];
  return Boolean(cookie && timingSafeEqual(Buffer.from(cookie), Buffer.from(session)));
}

function originAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === request.headers.host ||
      (parsed.protocol === 'https:' && parsed.hostname.endsWith('.ts.net'));
  } catch { return false; }
}

function proxy(request, response, target, pathname, search) {
  const headers = { ...request.headers };
  for (const key of Object.keys(headers)) {
    if (['host', 'cookie', 'origin', 'referer', 'connection', 'forwarded'].includes(key) ||
      key.startsWith('x-forwarded-')) delete headers[key];
  }
  headers.host = target.host;
  const upstream = nodeRequest({
    hostname: target.hostname, port: target.port, method: request.method,
    path: pathname + search, headers,
  }, (received) => {
    const resultHeaders = { ...received.headers };
    for (const key of ['set-cookie', 'connection', 'transfer-encoding', 'access-control-allow-origin',
      'access-control-allow-credentials']) delete resultHeaders[key];
    if (!response.headersSent) response.writeHead(received.statusCode || 502, resultHeaders);
    received.pipe(response);
  });
  upstream.on('error', () => {
    if (!response.headersSent) send(response, 502,
      JSON.stringify({ error: 'Lokalny silnik Luny jest niedostępny' }), 'application/json');
    else response.end();
  });
  request.on('aborted', () => upstream.destroy());
  request.pipe(upstream);
}

async function serveStatic(response, pathname) {
  let filename;
  try { filename = decodeURIComponent(pathname); } catch {
    return send(response, 400, 'Invalid path');
  }
  const relative = filename.replace(/^\/+/, '');
  const resolved = resolve(buildDir, relative || 'index.html');
  if (resolved !== buildDir && !resolved.startsWith(buildDir + sep)) {
    return send(response, 403, 'Forbidden');
  }
  try {
    const data = await readFile(resolved);
    response.writeHead(200, {
      'Content-Type': mime.get(extname(resolved)) || 'application/octet-stream',
      'Cache-Control': relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    response.end(data);
  } catch (error) {
    if (error?.code === 'ENOENT' && !extname(relative)) return serveStatic(response, '/index.html');
    send(response, error?.code === 'ENOENT' ? 404 : 500, 'File unavailable');
  }
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  const url = new URL(request.url || '/', 'http://luna.local');
  const pathname = url.pathname;
  if (!originAllowed(request)) return send(response, 403, 'Forbidden');

  if (pathname === '/_pair' && request.method === 'POST') {
    if (Date.now() > attemptsReset) { attempts = 0; attemptsReset = Date.now() + 10 * 60_000; }
    let input = '';
    for await (const chunk of request) {
      input += chunk;
      if (input.length > 1024) return send(response, 413, 'Request too large');
    }
    const supplied = new URLSearchParams(input).get('code') || '';
    attempts++;
    const a = Buffer.from(supplied);
    const b = Buffer.from(pairingCode);
    if (attempts > 10 || a.length !== b.length || !timingSafeEqual(a, b)) {
      return send(response, 401, 'Niepoprawny kod parowania lub zbyt wiele prób.');
    }
    attempts = 0;
    const secure = request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    response.writeHead(303, {
      'Set-Cookie': 'luna_mobile=' + session + '; HttpOnly; SameSite=Strict; Path=/' + secure,
      Location: '/', 'Cache-Control': 'no-store',
    });
    return response.end();
  }

  if (pathname === '/_logout' && request.method === 'POST') {
    response.writeHead(303, {
      'Set-Cookie': 'luna_mobile=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/',
      Location: '/', 'Cache-Control': 'no-store',
    });
    return response.end();
  }

  if (!authenticated(request)) {
    const publicPaths = ['/manifest.webmanifest', '/luna-icon.svg', '/mobile-login.html'];
    if (request.method === 'GET' && publicPaths.includes(pathname)) {
      return serveStatic(response, pathname);
    }
    if (request.method !== 'GET') return send(response, 401,
      JSON.stringify({ error: 'Pair your phone first' }), 'application/json');
    return serveStatic(response, '/mobile-login.html');
  }

  if (pathname.startsWith('/api/')) return proxy(request, response, hubUrl, pathname, url.search);
  if (['/ollama/api/tags', '/ollama/api/generate', '/ollama/api/ps', '/ollama/api/chat'].includes(pathname)) {
    return proxy(request, response, ollamaUrl, pathname.slice('/ollama'.length), url.search);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, 'Method not allowed');
  return serveStatic(response, pathname);
});

server.listen(port, host, () => {
  console.log('Luna Mobile: http://' + host + ':' + port);
  console.log('Kod parowania telefonu: ' + pairingCode);
  console.log('Połącz przez prywatny HTTPS Tailscale Serve (NIE Funnel): tailscale serve --bg ' + port);
  console.log('Kod zmienia się po każdym restarcie serwera mobilnego.');
});
