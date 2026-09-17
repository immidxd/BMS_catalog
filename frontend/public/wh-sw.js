// Service Worker Mini App «BMS Склад» — щоб застосунок ВІДКРИВАВСЯ без мережі.
//
// Стратегія навмисно проста й безпечна для деплою:
//   • /wh (оболонка)          — network-first: онлайн завжди свіжа з Railway,
//                               офлайн — остання успішно завантажена копія;
//   • /assets/*  (хеш у назві) — cache-first: не змінюються, живуть довго;
//   • SDK Telegram (telegram.org) — stale-while-revalidate (opaque, без CORS);
//   • /api/*                    — НІКОЛИ не кешується: дані складу живуть у
//                               хмарі, а без мережі їх дає localStorage-копія
//                               самого застосунку (offline.ts).
// Старі кеші прибираються на activate. Версія — у назві кешу.
const VERSION = 'wh-v1';
const SHELL = '/wh';
const SDK = 'https://telegram.org/js/telegram-web-app.js';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    try { await c.add(new Request(SHELL, { cache: 'reload' })); } catch (_) { /* офлайн при встановленні — оболонка зʼявиться при першому онлайн-відкритті */ }
    try { await c.add(new Request(SDK, { mode: 'no-cors' })); } catch (_) { /* те саме */ }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;                       // дані — лише мережа

  const isShell = url.origin === self.location.origin && (url.pathname === SHELL || url.pathname === SHELL + '/' || url.pathname === '/wh.html');
  const isAsset = url.origin === self.location.origin && url.pathname.startsWith('/assets/');
  const isSdk = req.url.startsWith(SDK);

  if (isShell) {
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) c.put(SHELL, fresh.clone());
        return fresh;
      } catch (_) {
        const hit = await c.match(SHELL);
        if (hit) return hit;
        throw _;
      }
    })());
    return;
  }
  if (isAsset || isSdk) {
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      const hit = await c.match(req);
      const refresh = fetch(isSdk ? new Request(SDK, { mode: 'no-cors' }) : req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) c.put(isSdk ? SDK : req, res.clone());
        return res;
      }).catch(() => undefined);
      if (hit) { if (isSdk) void refresh; return hit; }
      const res = await refresh;
      if (res) return res;
      throw new Error('offline and not cached');
    })());
  }
});
