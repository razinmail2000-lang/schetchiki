/* Офлайн-кэш: приложение работает на объекте без интернета.
   При обновлении файлов увеличьте VERSION. */
const VERSION = 'meters-v1.3.0';
const SHELL = [
  './', 'index.html', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png',
  'lib/exceljs.min.js', 'lib/jszip.min.js',
  'lib/tesseract/tesseract.min.js', 'lib/tesseract/worker.min.js', 'lib/tesseract/lang/eng.traineddata.gz',
  'lib/zxing/barcode-ponyfill.js', 'lib/zxing/zxing_reader.wasm',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // index/app.js — сначала сеть (чтобы приходили обновления), без сети — из кэша; остальное — из кэша
  const fresh = /\/(index\.html|app\.js)?$/.test(new URL(req.url).pathname);
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (fresh) {
      try { const r = await fetch(req); if (r.ok) cache.put(req, r.clone()); return r; }
      catch (err) { return (await cache.match(req, { ignoreSearch: true })) || Response.error(); }
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const r = await fetch(req);
    if (r.ok) cache.put(req, r.clone()); // ядро распознавания нужного типа кэшируется при первой загрузке
    return r;
  })());
});
