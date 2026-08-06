/* Версию бампаем при КАЖДОЙ выкладке — иначе у установленных приложений
   останется старый кеш, и правки увидят не сразу. */
const CACHE_NAME = 'sklad-v17';

/* Всё, что нужно приложению для полностью автономной работы: оболочка,
   иконки, сканер штрихкодов, генератор QR и шрифты. Раньше сканер, QR и
   шрифты грузились с CDN и в кеш не попадали (кросс-доменные ответы
   приходят opaque, со status 0) — без сети приложение оставалось без
   камеры и без печати этикеток. */
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './splash.jpg',
  './vendor/zxing.min.js',
  './vendor/qrcode.min.js',
  './vendor/supabase.min.js',
  './sync-config.js',
  './sync.js',
  './fonts/fonts.css',
  './fonts/Inter-400-cyrillic.woff2',
  './fonts/Inter-400-latin.woff2',
  './fonts/Inter-500-cyrillic.woff2',
  './fonts/Inter-500-latin.woff2',
  './fonts/Inter-600-cyrillic.woff2',
  './fonts/Inter-600-latin.woff2',
  './fonts/Inter-700-cyrillic.woff2',
  './fonts/Inter-700-latin.woff2',
  './fonts/JetBrainsMono-500-cyrillic.woff2',
  './fonts/JetBrainsMono-500-latin.woff2',
  './fonts/JetBrainsMono-600-cyrillic.woff2',
  './fonts/JetBrainsMono-600-latin.woff2',
  './fonts/JetBrainsMono-700-cyrillic.woff2',
  './fonts/JetBrainsMono-700-latin.woff2',
  './fonts/SpaceGrotesk-500-latin.woff2',
  './fonts/SpaceGrotesk-600-latin.woff2',
  './fonts/SpaceGrotesk-700-latin.woff2'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  /* Саму страницу берём из сети и только при её отсутствии — из кеша.
     Иначе после выкладки правок пользователь видел бы старую версию
     до второго запуска. */
  if (e.request.mode === 'navigate' || e.request.destination === 'document') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then((c) => c || caches.match('./index.html')))
    );
    return;
  }

  /* Остальная статика (шрифты, скрипты, иконки) меняется редко и весит
     много: отдаём из кеша сразу, а свежую версию подтягиваем фоном. */
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetchPromise = fetch(e.request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});