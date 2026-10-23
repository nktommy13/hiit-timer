/* =========================================================
   Service Worker —— 让 App 离线可用
   =========================================================
   策略：网络优先，失败时回落到缓存。
   选它而不是"缓存优先"，是因为开发阶段改代码后刷新就能看到最新版，
   不用手动清缓存。等成品稳定了，可以改成缓存优先以加快启动。
   ========================================================= */

const CACHE_NAME = 'hiit-v1';

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// 安装：预缓存全部资源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// 激活：清掉旧版本缓存
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// 取用：先走网络，拿到就顺手更新缓存；断网则用缓存
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME)
          .then(cache => cache.put(event.request, copy))
          .catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request)
        .then(cached => cached || caches.match('./index.html')))
  );
});
