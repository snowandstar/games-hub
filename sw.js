/* ===========================================================
   games-hub service worker
   原则：门禁站，缓存只碰"无用户数据"的东西。
   - 绝不缓存 /api/*
   - 绝不缓存带账号数据的页面（首页/留言/账号/工具…一律网络优先、不落盘）
   - 只预缓存三款纯静态小游戏 + 离线兜底页 + 图标
   =========================================================== */
var VERSION = "v1";
var CACHE = "ghub-" + VERSION;

var PRECACHE = [
  "/offline.html",
  "/game2048.html",
  "/minesweeper.html",
  "/snake.html",
  "/default.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("message", function (e) {
  if (e.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  if (url.origin !== location.origin) return;     // Ruffle CDN 等，直接走网络
  if (url.pathname.indexOf("/api/") === 0) return; // API 永不拦截

  // 页面导航：网络优先；断网时纯静态小游戏给缓存，其余给离线页
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).catch(function () {
        return caches.match(req).then(function (hit) {
          if (hit) return hit;
          return caches.match("/offline.html");
        });
      })
    );
    return;
  }

  // 其余同源静态资源（svg/png/字体内联…）：缓存优先 + 后台更新
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
