/* Mapa Lino — Service Worker (simples, “app feel”) */
const VERSION = 'v1.0.2';
const APP_CACHE = `mapalino-app-${VERSION}`;
const RUNTIME_CACHE = `mapalino-run-${VERSION}`;
const OFFLINE_FALLBACK_PAGE = 'offline.html';

const CORE_ASSETS = [
  './',
  'index.html',
  'admin.html',
  'offline.html',
  'manifest.webmanifest',
  'assets/styles.css',
  'assets/script.js',
  'assets/img/image.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k !== APP_CACHE && k !== RUNTIME_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* -------- Estratégias corrigidas -------- */
async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    // só cacheia GET bem-sucedido
    if (request.method === 'GET') {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch {
    const cached = await caches.match(request);
    return cached || await caches.match(OFFLINE_FALLBACK_PAGE) ||
           new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(request) {
  // ignora requisições de extensões ou protocolos não http/https
  const url = request.url;
  if (!url.startsWith('http')) {
    return fetch(request).catch(() => Response.error());
  }

  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);

  const fetching = fetch(request)
    .then((resp) => {
      // só guarda respostas válidas (status 200, tipo basic)
      if (resp && resp.ok && resp.type === 'basic') {
        cache.put(request, resp.clone()).catch(() => {});
      }
      return resp;
    })
    .catch(() => null);

  return cached || fetching || Response.error();
}


/* -------- Fetch handler com bypass e só-GET -------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 0) Nunca intercepta nada que não seja GET
  if (req.method !== 'GET') {
    event.respondWith(fetch(req));
    return;
  }

  const url = new URL(req.url);
  const isHTML = req.mode === 'navigate' || req.destination === 'document';

  // 1) Bypass para APIs de terceiros (evita CORS + “Failed to convert value to 'Response'”)
  const isThirdPartyAPI =
    url.origin !== self.location.origin &&
    (
      url.hostname.includes('open-meteo.com') ||
      url.hostname.includes('maps.co') ||
      url.hostname.includes('nominatim') ||
      url.hostname.includes('geocode')   // ajuste se usar outro provedor
    );

  if (isThirdPartyAPI) {
    event.respondWith(fetch(req)); // não cacheia, não toca
    return;
  }

  // 2) HTML: network-first com fallback offline
  if (isHTML) {
    event.respondWith(networkFirst(req));
    return;
  }

  // 3) Demais assets: SWR
  event.respondWith(staleWhileRevalidate(req));
});
