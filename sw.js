/* =========================================================
   Service Worker —— 让 App 离线可用
   =========================================================
   策略：网络优先，失败时回落到缓存。
   选它而不是"缓存优先"，是因为开发阶段改代码后刷新就能看到最新版，
   不用手动清缓存。等成品稳定了，可以改成缓存优先以加快启动。
   ========================================================= */

const CACHE_NAME = 'hiit-v2';

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

// 取用：先走网络，失败时回落到缓存。
//
// 为什么不直接用"缓存优先"：开发阶段改完代码刷新就该看到最新版，
// 缓存优先会让人以为改动没生效，反而更难排查。等成品稳定了想更快启动，
// 可以改成 stale-while-revalidate（立刻返回缓存，后台静默更新）。
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const isPageNavigation = event.request.mode === 'navigate';

  event.respondWith((async () => {
    try {
      // 弱网下 fetch 可能挂好几秒才失败，界面会一直空白。
      // 加个超时，到点就先用缓存把界面撑起来。
      const response = await fetchWithTimeout(event.request, 2500);

      // 关键：fetch 对 404 / 500 / 酒店强制门户页面同样是"成功"，
      // 不加判断就写缓存，一个坏响应就会覆盖掉好的离线副本。
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        // 等写入完成再返回。respondWith 的 promise 本身会保活 Service Worker，
        // 所以这里不必用 event.waitUntil —— 规范要求 waitUntil 必须在事件分发
        // 期间同步注册，在 await 之后调用会抛 InvalidStateError。
        // 代价只是几毫秒的写入时间，肉眼不可见。
        await caches.open(CACHE_NAME)
          .then(cache => cache.put(event.request, copy))
          .catch(() => {});
      }
      return response;

    } catch (err) {
      const cached = await caches.match(event.request);
      if (cached) return cached;

      // 只有页面导航才回落到 index.html。
      // 否则一个缺失的 css 或图标会被换成 HTML 返回，报错更难定位。
      if (isPageNavigation) {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }

      return new Response('离线，且缓存中没有这份资源', {
        status: 503,
        statusText: 'Offline',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});

/** 带超时的 fetch。超时并非中止请求，只是不再等它 */
function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('网络超时')), ms);
    fetch(request).then(
      response => { clearTimeout(timer); resolve(response); },
      error    => { clearTimeout(timer); reject(error); },
    );
  });
}
