/* 服务工作者：缓存应用外壳，离线可用（PWA 安装到桌面/手机需要 http/https 环境） */
const CACHE = 'hsp-v1';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/sync.js',
  './js/player.js',
  './js/annotate.js',
  './js/editor.js',
  './js/presenter.js',
  './js/main.js',
  './sample/sample-deck.html',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request).then((res) => {
      const clone = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, clone));
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
