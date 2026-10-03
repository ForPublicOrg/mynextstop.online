// The service worker behind "Install app". It is what lets the installed app
// open like an app: on a weak signal, or none, the shell, the catalogue and
// Leaflet come from this cache, so the season dots, picks and cards all work
// and only the map tiles stay blank. Tiles, place search and routing are
// cross-origin and never touched here.
//
//   pages             network first, the cached copy offline or after
//                     NET_WAIT_MS; a page never opened before gets a note
//   ?v= tagged files  cache first: a tag never changes under the same URL,
//   and pinned Leaflet  and caching the new tag drops the old one
//   other files       network first, same fallback (data, icons, untagged
//                     css/js)
//
// Bump VERSION only when the rules in this file change. Content updates
// ride on the ?v= tags and on network first, so a deploy needs nothing here.
const VERSION = 'v1';
const STATIC = `mns-static-${VERSION}`;
const PAGES = `mns-pages-${VERSION}`;
const PAGE_LIMIT = 40;
const NET_WAIT_MS = 4000;

const LEAFLET = /^https:\/\/unpkg\.com\/leaflet@[\d.]+\/dist\//;
const KEEP_EXT = /\.(?:js|mjs|css|json|geojson|png|svg|ico|webmanifest)$/i;
// fetched by the app's code, so they are not named in index.html
const PRECACHE = ['/data/destinations.json', '/data/holidays.json', '/data/india-border.geojson'];

const ok = res => res && res.ok && (res.type === 'basic' || res.type === 'cors');

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const urls = new Set(PRECACHE);
    try {
      // The app page names its own files, ?v= tags included: read them off
      // it, so a version bump never needs an edit here.
      const res = await fetch('/');
      if (ok(res)) {
        const html = await res.clone().text();
        await (await caches.open(PAGES)).put('/', res);
        for (const [, ref] of html.matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)="([^"]+)"/g)) {
          const u = new URL(ref, self.location.origin + '/');
          const own = u.origin === self.location.origin && !u.pathname.startsWith('/_vercel/');
          if ((own && KEEP_EXT.test(u.pathname)) || LEAFLET.test(u.href)) urls.add(u.href);
        }
      }
    } catch { /* offline install: the runtime rules fill the cache later */ }
    const cache = await caches.open(STATIC);
    await Promise.all([...urls].map(u => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('mns-') && key !== STATIC && key !== PAGES) await caches.delete(key);
    }
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!url.protocol.startsWith('http')) return;

  if (req.mode === 'navigate') {
    if (url.origin === self.location.origin) event.respondWith(page(event, url));
    return;
  }
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/_vercel/')) return;   // analytics, never cached
    if (/[?&]v=/.test(url.search)) event.respondWith(cacheFirst(event, req, url));
    else if (KEEP_EXT.test(url.pathname)) event.respondWith(networkFirst(event, fetch(req), STATIC, req));
    return;
  }
  if (LEAFLET.test(req.url)) event.respondWith(cacheFirst(event, req, url));
});

async function page(event, url) {
  // one copy per path: "/?to=goa" and "/?source=app" are the same document
  const key = url.pathname;
  const net = (async () => (await event.preloadResponse) || fetch(event.request))();
  try {
    return await networkFirst(event, net, PAGES, key);
  } catch {
    return offlinePage();
  }
}

// `net` is the response promise, already in flight. A cached copy answers
// when the network fails, errors, or is slower than NET_WAIT_MS (a hung
// connection on a weak signal); the network's answer still refreshes the
// cache. The refresh is registered before the response is handed over, so
// the worker stays alive for it even when the cached copy won the race.
async function networkFirst(event, net, cacheName, key, wait = NET_WAIT_MS) {
  const cache = await caches.open(cacheName);
  event.waitUntil(net.then(res => ok(res) && cache.put(key, res.clone())
    .then(() => cacheName === PAGES && trimPages(cache))).catch(() => {}));
  const cached = await cache.match(key, { ignoreVary: true });
  if (!cached) return net;
  const fresh = net.then(res => (res.status >= 500 ? cached : res), () => cached);
  return Promise.race([fresh, new Promise(r => setTimeout(r, wait, cached))]);
}

async function cacheFirst(event, req, url) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (ok(res)) {
    const copy = res.clone();
    event.waitUntil(cache.put(req, copy).then(() => dropOldTags(cache, url)));
  }
  return res;
}

// app.js?v=e5 landing retires app.js?v=e4
async function dropOldTags(cache, url) {
  if (url.origin !== self.location.origin) return;
  for (const k of await cache.keys()) {
    const u = new URL(k.url);
    if (u.origin === url.origin && u.pathname === url.pathname && u.search !== url.search) await cache.delete(k);
  }
}

// keys() lists in put order, so the front is the least recently refreshed
async function trimPages(cache) {
  const keys = await cache.keys();
  const extra = keys.filter(k => new URL(k.url).pathname !== '/').slice(0, Math.max(0, keys.length - PAGE_LIMIT));
  await Promise.all(extra.map(k => cache.delete(k)));
}

function offlinePage() {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Offline · my next stop</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f8fa; --ink: #1b1e22; --muted: #67717c; --accent: #0e7a6c; --on: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #14171a; --ink: #eceff2; --muted: #9aa4af; --accent: #34b3a0; --on: #06231f; } }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: var(--bg); color: var(--ink);
         font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", sans-serif; }
  main { max-width: 340px; padding: 24px; text-align: center; }
  h1 { font-size: 22px; margin: 0 0 8px; letter-spacing: -.02em; }
  p { color: var(--muted); margin: 0 0 22px; }
  a { display: inline-block; background: var(--accent); color: var(--on); text-decoration: none;
      font-weight: 650; padding: 12px 22px; border-radius: 999px; }
</style></head>
<body><main>
  <h1>You’re offline</h1>
  <p>This page isn’t saved on this device yet. Pages you have opened before still work without a connection.</p>
  <a href="/">Open my next stop</a>
</main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  });
}
