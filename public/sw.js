'use strict';

const CACHE = 'bpc-v1';

const SHELL = [
  '/index.html',
  '/lobby.html',
  '/table.html',
  '/admin.html',
  '/host-apply.html',
  '/rail.html',
  '/css/style.css',
  '/js/auth.js',
  '/js/lobby.js',
  '/js/table.js',
  '/js/admin.js',
  '/js/rail.js',
  '/js/pwa.js',
  '/manifest.json',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept API calls, socket connections, or cross-origin requests
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
  if (url.origin !== self.location.origin) return;

  // Navigation requests: network-first, fall back to cached page, then offline page
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .catch(() => caches.match(e.request)
          .then(cached => cached || caches.match('/index.html')
            .then(fallback => fallback || offlinePage())
          )
        )
    );
    return;
  }

  // Static assets: cache-first, update cache in background
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      });
      return cached || network;
    })
  );
});

function offlinePage() {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Offline — Boston Poker Club</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#040e07;color:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}
    .card{max-width:320px}
    .icon{font-size:4rem;margin-bottom:16px}
    h1{color:#c8a84b;font-size:1.6rem;margin-bottom:12px}
    p{color:#aaa;line-height:1.6;font-size:.95rem;margin-bottom:28px}
    button{background:#c8a84b;color:#040e07;border:none;border-radius:10px;
           padding:14px 32px;font-size:1rem;font-weight:700;cursor:pointer;width:100%}
    button:active{opacity:.85}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🐇</div>
    <h1>You're Offline</h1>
    <p>No internet connection detected. Check your network and try again.</p>
    <button onclick="location.reload()">Try Again</button>
  </div>
</body>
</html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
