// Service worker: app shell works offline; API GETs fall back to the last cached response
// so the overview still shows the latest known state when signal drops at the ponds.

const VERSION = 'v1';
const SHELL = `sff-shell-${VERSION}`;
const API = 'sff-api';

const SHELL_FILES = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/api.js',
  '/js/store.js',
  '/js/router.js',
  '/js/format.js',
  '/js/components/ts-chart.js',
  '/js/pages/overview.js',
  '/js/pages/pond.js',
  '/js/pages/alarms.js',
  '/js/pages/manual.js',
  '/js/pages/login.js',
  '/shared/index.js',
  '/shared/thresholds.js',
  '/shared/topics.js',
  '/shared/ponds.js',
  '/vendor/uplot/uPlot.esm.js',
  '/vendor/uplot/uPlot.min.css',
  '/manifest.webmanifest',
  '/icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('sff-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: cacheName === SHELL && req.mode === 'navigate' });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match('/index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname === '/api/stream') return; // SSE: never intercept
  if (url.pathname.startsWith('/api/auth') || url.pathname === '/api/me') return;

  if (url.pathname.startsWith('/api/')) {
    e.respondWith(networkFirst(req, API));
    return;
  }
  e.respondWith(networkFirst(req, SHELL));
});
