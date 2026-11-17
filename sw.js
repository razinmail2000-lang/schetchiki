/* Офлайн-кэш: приложение работает на объекте без интернета.
   При обновлении файлов увеличьте VERSION. */
const VERSION = 'meters-v1.7.0';
const SHELL = [
  './', 'index.html', 'app.js', 'pass.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png',
  'lib/exceljs.min.js', 'lib/jszip.min.js',
  'lib/ort/ort.wasm.min.js', 'lib/paddle/paddle-ocr.js',
  'lib/tesseract/tesseract.min.js', 'lib/tesseract/worker.min.js', 'lib/tesseract/lang/eng.traineddata.gz',
  'lib/zxing/barcode-ponyfill.js', 'lib/zxing/zxing_reader.wasm',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    const oldKeys = (await caches.keys()).filter(k => k.startsWith('meters-') && k !== VERSION);
    for (const key of oldKeys) {
      const old = await caches.open(key);
      // Уже скачанные модели сохраняем при обновлении: ocrReady хранится отдельно от кэша.
      for (const req of await old.keys()) {
        if (/\/lib\/(paddle|ort|tesseract|zxing)\//.test(new URL(req.url).pathname) && !await cache.match(req)) {
          const response = await old.match(req);
          if (response) await cache.put(req, response);
        }
      }
      await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // index/app.js/pass.js — сначала сеть (обновления и новый пароль), без сети — из кэша; остальное — из кэша
  const fresh = /\/(index\.html|app\.js|pass\.js)?$/.test(new URL(req.url).pathname);
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (fresh) {
      try { const r = await fetch(req); if (r.ok) { await cache.put(req, r.clone()); return r; } return (await cache.match(req, { ignoreSearch: true })) || r; }
      catch (err) { return (await cache.match(req, { ignoreSearch: true })) || Response.error(); }
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const r = await fetch(req);
    if (r.ok) await cache.put(req, r.clone()); // ядро распознавания нужного типа кэшируется до завершения загрузки
    return r;
  })());
});
