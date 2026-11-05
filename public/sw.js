// Network-only service worker: never cache private conversation or Agent Hub data.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="pl"><meta name="viewport" content="width=device-width"><title>Luna offline</title><body style="font:18px system-ui;background:#080b12;color:white;padding:28px"><h1>Luna jest offline</h1><p>Włącz komputer z Luną i połączenie Tailscale na telefonie.</p></body></html>',
    {status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}}
  )));
});
