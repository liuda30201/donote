const CACHE_NAME = 'web-clipboard-v2.5.0';
// 注意：不要在这里放 /share.html、/share.js。
// 分享功能在应用层与 nginx 层都已整体禁用（固定返回 404），把这两个路径写进
// 预缓存列表会让 cache.addAll() 整体失败（它要求每个请求都 2xx），
// 结果是 install 事件 reject，**整个 Service Worker 装不上**、离线能力全废。
const ASSETS = [
  '/',
  '/index.html',
  '/landing.css?v=3',
  '/landing.js?v=1',
  '/images/workspace-overview.png',
  '/images/workspace-overview.webp',
  '/images/collect-paste.png',
  '/images/collect-paste.webp',
  '/images/search-preview.png',
  '/images/search-preview.webp',
  '/images/across-devices.png',
  '/images/across-devices.webp',
  '/app.html',
  '/offline.html',
  '/style.css?v=2.1.8',
  '/app.js?v=2.1.4',
  '/highlight.js',
  '/heic2any.min.js',
  '/logo.png',
  '/apple-touch-icon.png',
  '/favicon.svg',
  '/socket.io/socket.io.js'
];

// 安装 Service Worker 并预缓存核心静态资产
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

// 激活并清理旧版本的缓存
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('清理旧缓存:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Compatibility purge for older workers that cached private responses; current
// fetch policy never adds these routes. Keep this to remove pre-upgrade entries.
self.addEventListener('message', e => {
  if (e.data?.type !== 'CLEAR_PRIVATE_CACHE') return;
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(async key => {
    const cache = await caches.open(key); const requests = await cache.keys();
    await Promise.all(requests.filter(request => /^\/(api|uploads|socket\.io)\//.test(new URL(request.url).pathname)).map(request => cache.delete(request)));
  }))));
});

// 拦截 fetch 请求
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // 安全排除：API、大文件上传目录以及 Socket.IO 连接不进行 Service Worker 拦截缓存
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/uploads/') ||
    url.pathname.startsWith('/socket.io/')
  ) {
    return;
  }

  // HTML 页面与根导航：网络优先（Network-First），确保服务端发布新版后用户刷新立即可见；离线时降级到本地缓存
  if (e.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, responseClone));
          }
          return networkResponse;
        })
        .catch(async () => {
          const cached = await caches.match(e.request, { ignoreSearch: true });
          if (cached) return cached;
          if (['/app', '/app/', '/login', '/login/'].includes(url.pathname)) {
            return (await caches.match('/app.html')) || Response.error();
          }
          return (await caches.match('/offline.html')) || Response.error();
        })
    );
    return;
  }

  // 静态资产（CSS / JS / 图标等）：网络优先，失败或离线时忽略 ?v= 查询参数回退到本地缓存
  e.respondWith(
    fetch(e.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, responseClone));
        }
        return networkResponse;
      })
      .catch(() =>
        caches.match(e.request, { ignoreSearch: true }).then((cachedResponse) => {
          return cachedResponse || Response.error();
        })
      )
  );
});
