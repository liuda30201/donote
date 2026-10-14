const CACHE_NAME = 'web-clipboard-v1.7.5';
// 注意：不要在这里放 /share.html、/share.js。
// 分享功能在应用层与 nginx 层都已整体禁用（固定返回 404），把这两个路径写进
// 预缓存列表会让 cache.addAll() 整体失败（它要求每个请求都 2xx），
// 结果是 install 事件 reject，**整个 Service Worker 装不上**、离线能力全废。
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/highlight.js',
  '/heic2any.min.js',
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

// 拦截 fetch 请求
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

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
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // 静态资产（带版本号的 CSS / JS / 图标等）：缓存优先，后台静默更新
  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      if (cachedResponse) {
        fetch(e.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, networkResponse));
          }
        }).catch(() => { });
        return cachedResponse;
      }
      return fetch(e.request);
    })
  );
});
