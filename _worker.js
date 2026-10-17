// Cloudflare Pages 单文件 Worker 模式（advanced mode）
// 处理：静态资源 + /api/games + /api/swf（大 SWF 转发，私有 Release + Token）
//
// 数据源说明：游戏列表以内嵌数组为权威（部署时随 Worker 更新）；
// 仓库内 games.json 为本地开发参考副本，新增游戏时两处需同步。

const games = [
  {
    "id": "minecraft-188",
    "name": "我的世界 1.8.8",
    "type": "h5",
    "size": 14.4,
    "icon": "/default.svg",
    "url": "/minecraft.html"
  },
  {
    "id": "minecraft-1122",
    "name": "我的世界 1.12.2",
    "type": "h5",
    "size": 19.2,
    "icon": "/default.svg",
    "url": "/minecraft-1122.html"
  },
  {
    "id": "minecraft-125",
    "name": "我的世界 1.2.5",
    "type": "h5",
    "size": 6,
    "icon": "/default.svg",
    "url": "/minecraft-125.html"
  },
  {
    "id": "minecraft-classic",
    "name": "我的世界 Classic 0.30",
    "type": "h5",
    "size": 3.6,
    "icon": "/default.svg",
    "url": "/minecraft-classic.html"
  },
  {
    "id": "bleshui-vs-huoYing-3.2",
    "name": "死神VS火影 3.2",
    "type": "flash",
    "size": 58.9,
    "icon": "/bh32.jpg",
    "swf": "bh32.swf"
  },
  {
    "id": "bleshui-vs-huoYing-3.3",
    "name": "死神VS火影 3.3",
    "type": "flash",
    "size": 65.9,
    "icon": "/bh33.jpg",
    "swf": "bh33.swf"
  },
  {
    "id": "game2048",
    "name": "2048",
    "type": "h5",
    "icon": "/default.svg",
    "url": "/game2048.html"
  },
  {
    "id": "minesweeper",
    "name": "扫雷",
    "type": "h5",
    "icon": "/default.svg",
    "url": "/minesweeper.html"
  },
  {
    "id": "snake",
    "name": "贪吃蛇",
    "type": "h5",
    "icon": "/default.svg",
    "url": "/snake.html"
  }
];

// 私有仓库 Release（不公开，需 Token 访问）
// GitHub 私有 Release 资产必须走 API 资产端点（releases/download 对 fine-grained token 返回 404）
const ASSET_API = "https://api.github.com/repos/snowandstar/games-assets/releases/assets";
const ASSET_IDS = {
  "bh32.swf": 629342885,
  "bh33.swf": 629342897
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin"
};

// AI 助手应用（妙搭 iframe）跨域调用站点 API 所需的 CORS 头
const AI_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://4m8dv3g0c7b16.doubao.link",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
      ...(cors ? AI_CORS_HEADERS : {})
    }
  });
}

// ---------- 账号系统辅助函数 ----------
const PBKDF2_ITER = 100000;
const SESSION_TTL = 3600 * 24 * 30; // 30 天
const FAIL_TTL = 900; // 防爆破锁定 15 分钟
const MAX_FAIL = 5;

// 盐存 hex 字符串，哈希时用其 UTF-8 字节作为 PBKDF2 salt（注册/登录输入一致）
async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode(saltHex), iterations: PBKDF2_ITER, hash: "SHA-256" },
    key, 256
  );
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function randHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}
function constEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function clientIP(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}
function bearerToken(request) {
  const h = request.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}
// 校验 token，返回 { username, admin } 或 null
async function getAuth(request, env) {
  const token = bearerToken(request);
  if (!token) return null;
  const s = await env.MSG_KV.get("sess:" + token, "json");
  if (!s || !s.exp || s.exp < Date.now()) return null;
  const u = await env.MSG_KV.get("user:" + s.username, "json");
  if (!u) return null;
  return { username: s.username, admin: !!u.admin, avatar: u.avatar || "" };
}
async function checkFail(env, ip) {
  const n = parseInt((await env.MSG_KV.get("fail:" + ip)) || "0", 10);
  if (n >= MAX_FAIL) return true;
  return false;
}
async function recordFail(env, ip) {
  const k = "fail:" + ip;
  const n = parseInt((await env.MSG_KV.get(k)) || "0", 10) + 1;
  await env.MSG_KV.put(k, String(n), { expirationTtl: FAIL_TTL });
}
async function clearFail(env, ip) {
  await env.MSG_KV.delete("fail:" + ip);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // AI 接口跨域预检
    if (request.method === "OPTIONS" && path.startsWith("/api/ai/")) {
      return new Response(null, { status: 204, headers: { ...AI_CORS_HEADERS, ...SECURITY_HEADERS } });
    }

    // 整站登录门禁：除登录页与 API 外，未登录一律跳转登录页
    if (path === "/" || path === "/index.html" || /^\/(tools|media|guestbook|game|game2048|minesweeper|snake|minecraft|account|ai-admin)/.test(path)) {
      const c = request.headers.get("Cookie") || "";
      const m = c.match(/(?:^|;\s*)ghub_token=([^;]+)/);
      const t = m ? decodeURIComponent(m[1]) : "";
      const sess = t ? await env.MSG_KV.get("sess:" + t, "json") : null;
      if (!sess || !sess.exp || sess.exp < Date.now()) {
        return Response.redirect(new URL("/login.html", url), 302);
      }
    }

    // 游戏列表接口
    if (path === "/api/games") {
      return json(games);
    }

    // 大 SWF 转发（私有 GitHub Release，带 Token）
    if (path === "/api/swf") {
      const id = url.searchParams.get("id") || "";
      const game = games.find(g => g.id === id);
      if (!game) {
        return json({ error: "Game not found" }, 404);
      }
      const token = env.GH_TOKEN || "";
      if (!token) {
        return json({ error: "GH_TOKEN not configured" }, 500);
      }
      const assetId = ASSET_IDS[game.swf];
      if (!assetId) {
        return json({ error: "Asset id not found" }, 404);
      }
      // Cloudflare Cache API 显式缓存（Pages Worker 响应默认不进 CDN 缓存）
      const cacheKey = new Request(url, { method: "GET" });
      const cache = caches.default;
      try {
        const cached = await cache.match(cacheKey);
        if (cached) {
          return cached;
        }
      } catch (e) {
        // cache 异常不影响主流程
      }
      const remoteUrl = `${ASSET_API}/${assetId}`;
      try {
        const resp = await fetch(remoteUrl, {
          headers: {
            "User-Agent": "Cloudflare-Pages",
            "Authorization": `Bearer ${token}`,
            "Accept": "application/octet-stream"
          },
          redirect: "follow"
        });
        if (!resp.ok) {
          return json({ error: `Release asset fetch failed: ${resp.status}` }, 502);
        }
        const headers = {
          "Content-Type": "application/x-shockwave-flash",
          "Cache-Control": "public, max-age=2592000, s-maxage=2592000, stale-while-revalidate=86400",
          ...SECURITY_HEADERS
        };
        const len = resp.headers.get("Content-Length");
        if (len) headers["Content-Length"] = len;
        const out = new Response(resp.body, { headers });
        ctx.waitUntil(cache.put(cacheKey, out.clone()));
        return out;
      } catch (e) {
        return json({ error: `Fetch error: ${e.message}` }, 502);
      }
    }

    // ---------- 账号系统接口 ----------
    if (path === "/api/auth/register") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const ip = clientIP(request);
      if (await checkFail(env, ip)) return json({ error: "尝试次数过多，请 15 分钟后再试" }, 429);
      let body = null;
      try { body = await request.json(); } catch (e) {}
      const username = String(body && body.username || "").trim();
      const password = String(body && body.password || "");
      if (!/^[\w\u4e00-\u9fa5]{2,20}$/.test(username)) {
        return json({ error: "用户名需 2-20 位字母、数字、下划线或中文" }, 400);
      }
      if (password.length < 6 || password.length > 64) {
        return json({ error: "密码需 6-64 位" }, 400);
      }
      if (await env.MSG_KV.get("user:" + username)) {
        return json({ error: "用户名已被注册" }, 409);
      }
      // 第一个注册的账号自动成为管理员
      const listed = await env.MSG_KV.list({ prefix: "user:" });
      const isAdmin = listed.keys.length === 0;
      const salt = randHex(16);
      const hash = await hashPassword(password, salt);
      await env.MSG_KV.put("user:" + username, JSON.stringify({ salt, hash, admin: isAdmin, created: Date.now() }));
      await clearFail(env, ip);
      return json({ ok: true, admin: isAdmin });
    }

    if (path === "/api/auth/login") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const ip = clientIP(request);
      if (await checkFail(env, ip)) return json({ error: "尝试次数过多，请 15 分钟后再试" }, 429);
      let body = null;
      try { body = await request.json(); } catch (e) {}
      const username = String(body && body.username || "").trim();
      const password = String(body && body.password || "");
      const rec = await env.MSG_KV.get("user:" + username, "json");
      if (!rec) {
        await recordFail(env, ip);
        return json({ error: "用户名或密码错误" }, 401);
      }
      const hash = await hashPassword(password, rec.salt);
      if (!constEq(hash, rec.hash)) {
        await recordFail(env, ip);
        return json({ error: "用户名或密码错误" }, 401);
      }
      await clearFail(env, ip);
      const token = randHex(32);
      await env.MSG_KV.put("sess:" + token, JSON.stringify({ username, exp: Date.now() + SESSION_TTL * 1000 }), { expirationTtl: SESSION_TTL });
      return new Response(JSON.stringify({ ok: true, token, username, admin: !!rec.admin }), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Set-Cookie": `ghub_token=${token}; Path=/; Max-Age=2592000; SameSite=Lax`,
          ...SECURITY_HEADERS
        }
      });
    }

    if (path === "/api/auth/me") {
      const auth = await getAuth(request, env);
      if (!auth) return json({ error: "未登录" }, 401);
      return json({ ok: true, username: auth.username, admin: auth.admin, avatar: auth.avatar });
    }

    // 预设头像集合（服务端白名单）
    const AVATARS = ["🎮", "🕹️", "👾", "🚀", "⭐", "🔥", "🎧", "🏆", "💎", "🐱", "🐶", "🦊", "🐼", "🌈", "👑", "🤖"];

    // 修改用户名（同步更新历史留言 + 重新签发会话）
    if (path === "/api/auth/change-username") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const auth = await getAuth(request, env);
      if (!auth) return json({ error: "未登录" }, 401);
      let body = null;
      try { body = await request.json(); } catch (e) {}
      const nn = String(body && body.new_username || "").trim();
      if (!/^[\w\u4e00-\u9fa5]{2,20}$/.test(nn)) {
        return json({ error: "用户名需 2-20 位字母、数字、下划线或中文" }, 400);
      }
      if (nn === auth.username) return json({ ok: true });
      if (await env.MSG_KV.get("user:" + nn)) {
        return json({ error: "该用户名已被占用" }, 409);
      }
      const old = await env.MSG_KV.get("user:" + auth.username, "json");
      if (!old) return json({ error: "账号不存在" }, 404);
      await env.MSG_KV.put("user:" + nn, JSON.stringify({ ...old, username: nn }));
      await env.MSG_KV.delete("user:" + auth.username);
      // 更新历史留言里的名字
      const msgs = (await env.MSG_KV.get("msgs", "json")) || [];
      if (Array.isArray(msgs) && msgs.length) {
        let changed = false;
        for (const m of msgs) {
          if (m.name === auth.username) { m.name = nn; changed = true; }
        }
        if (changed) await env.MSG_KV.put("msgs", JSON.stringify(msgs));
      }
      // 重新签发会话（新 token 绑定新用户名）
      const oldTok = bearerToken(request);
      if (oldTok) await env.MSG_KV.delete("sess:" + oldTok);
      const token = randHex(32);
      await env.MSG_KV.put("sess:" + token, JSON.stringify({ username: nn, exp: Date.now() + SESSION_TTL * 1000 }), { expirationTtl: SESSION_TTL });
      return new Response(JSON.stringify({ ok: true, token, username: nn, admin: auth.admin, avatar: auth.avatar }), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Set-Cookie": `ghub_token=${token}; Path=/; Max-Age=2592000; SameSite=Lax`,
          ...SECURITY_HEADERS
        }
      });
    }

    // 修改密码（需验证旧密码）
    if (path === "/api/auth/change-password") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const auth = await getAuth(request, env);
      if (!auth) return json({ error: "未登录" }, 401);
      let body = null;
      try { body = await request.json(); } catch (e) {}
      const oldP = String(body && body.old_password || "");
      const newP = String(body && body.new_password || "");
      if (newP.length < 6 || newP.length > 64) {
        return json({ error: "新密码需 6-64 位" }, 400);
      }
      const rec = await env.MSG_KV.get("user:" + auth.username, "json");
      if (!rec) return json({ error: "账号不存在" }, 404);
      const oldHash = await hashPassword(oldP, rec.salt);
      if (!constEq(oldHash, rec.hash)) {
        return json({ error: "旧密码错误" }, 401);
      }
      const salt = randHex(16);
      const hash = await hashPassword(newP, salt);
      await env.MSG_KV.put("user:" + auth.username, JSON.stringify({ ...rec, salt, hash }));
      return json({ ok: true });
    }

    // 修改头像（预设白名单）
    if (path === "/api/auth/update-avatar") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const auth = await getAuth(request, env);
      if (!auth) return json({ error: "未登录" }, 401);
      let body = null;
      try { body = await request.json(); } catch (e) {}
      const av = String(body && body.avatar || "");
      if (!AVATARS.includes(av)) {
        return json({ error: "请选择预设头像" }, 400);
      }
      const rec = await env.MSG_KV.get("user:" + auth.username, "json");
      if (!rec) return json({ error: "账号不存在" }, 404);
      await env.MSG_KV.put("user:" + auth.username, JSON.stringify({ ...rec, avatar: av }));
      return json({ ok: true, avatar: av });
    }

    if (path === "/api/auth/logout") {
      const token = bearerToken(request);
      if (token) await env.MSG_KV.delete("sess:" + token);
      const c = request.headers.get("Cookie") || "";
      const m = c.match(/(?:^|;\s*)ghub_token=([^;]+)/);
      if (m) await env.MSG_KV.delete("sess:" + decodeURIComponent(m[1]));
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Set-Cookie": "ghub_token=; Path=/; Max-Age=0; SameSite=Lax",
          ...SECURITY_HEADERS
        }
      });
    }

    // 留言板接口（Cloudflare KV 持久化；发留言必须登录，管理员可删除）
    if (path === "/api/msg") {
      if (request.method === "GET") {
        const v = await env.MSG_KV.get("msgs", "json");
        return json(Array.isArray(v) ? v : []);
      }
      if (request.method === "POST") {
        const auth = await getAuth(request, env);
        if (!auth) return json({ error: "请先登录再留言" }, 401);
        try {
          const body = await request.json();
          const text = String(body.text || "").trim().slice(0, 500);
          if (!text) return json({ error: "留言内容不能为空" }, 400);
          const list = (await env.MSG_KV.get("msgs", "json")) || [];
          list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), name: auth.username, avatar: auth.avatar, text, time: Date.now() });
          if (list.length > 200) list.splice(0, list.length - 200);
          await env.MSG_KV.put("msgs", JSON.stringify(list));
          return json({ ok: true, count: list.length });
        } catch (e) {
          return json({ error: `留言写入失败: ${e.message}` }, 500);
        }
      }
      if (request.method === "DELETE") {
        const auth = await getAuth(request, env);
        if (!auth || !auth.admin) return json({ error: "需要管理员权限" }, 403);
        const id = url.searchParams.get("id") || "";
        if (!id) return json({ error: "缺少留言 id" }, 400);
        const list = (await env.MSG_KV.get("msgs", "json")) || [];
        const next = list.filter(m => m.id !== id);
        if (next.length === list.length) return json({ error: "留言不存在" }, 404);
        await env.MSG_KV.put("msgs", JSON.stringify(next));
        return json({ ok: true });
      }
      return json({ error: "method not allowed" }, 405);
    }

    // ===== AI 助手：预设模型管理与聊天代理（CORS 允许妙搭应用调用）=====
    if (path.startsWith("/api/ai/")) {
      // 预设模型列表（登录可见，不含 Key）
      if (path === "/api/ai/presets" && request.method === "GET") {
        const auth = await getAuth(request, env);
        if (!auth) return json({ error: "未登录" }, 401, true);
        const list = (await env.MSG_KV.get("ai_presets", "json")) || [];
        return json({ ok: true, presets: list.map(p => ({ id: p.id, name: p.name, baseURL: p.baseURL, model: p.model, desc: p.desc })) }, 200, true);
      }
      // 新增预设（管理员）
      if (path === "/api/ai/presets" && request.method === "POST") {
        const auth = await getAuth(request, env);
        if (!auth || !auth.admin) return json({ error: "需要管理员权限" }, 403, true);
        try {
          const body = await request.json();
          const name = String(body.name || "").trim();
          const baseURL = String(body.baseURL || "").trim();
          const model = String(body.model || "").trim();
          const key = String(body.key || "").trim();
          if (!name || !baseURL || !model || !key) return json({ error: "名称、API 地址、模型、Key 都不能为空" }, 400, true);
          if (!/^https:\/\//.test(baseURL)) return json({ error: "API 地址必须是 https 链接" }, 400, true);
          const list = (await env.MSG_KV.get("ai_presets", "json")) || [];
          const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          list.push({ id, name, baseURL, model, key, desc: String(body.desc || "").slice(0, 120) });
          await env.MSG_KV.put("ai_presets", JSON.stringify(list));
          return json({ ok: true, id }, 200, true);
        } catch (e) { return json({ error: `保存失败: ${e.message}` }, 500, true); }
      }
      // 更新预设（管理员）
      if (path === "/api/ai/presets" && request.method === "PUT") {
        const auth = await getAuth(request, env);
        if (!auth || !auth.admin) return json({ error: "需要管理员权限" }, 403, true);
        try {
          const body = await request.json();
          const id = String(body.id || "");
          const list = (await env.MSG_KV.get("ai_presets", "json")) || [];
          const idx = list.findIndex(p => p.id === id);
          if (idx < 0) return json({ error: "预设不存在" }, 404, true);
          const cur = list[idx];
          const name = String(body.name !== undefined ? body.name : cur.name).trim();
          const baseURL = String(body.baseURL !== undefined ? body.baseURL : cur.baseURL).trim();
          const model = String(body.model !== undefined ? body.model : cur.model).trim();
          const key = body.key ? String(body.key).trim() : cur.key;
          if (!name || !baseURL || !model) return json({ error: "名称、API 地址、模型不能为空" }, 400, true);
          if (!/^https:\/\//.test(baseURL)) return json({ error: "API 地址必须是 https 链接" }, 400, true);
          list[idx] = { ...cur, name, baseURL, model, key, desc: String(body.desc !== undefined ? body.desc : cur.desc).slice(0, 120) };
          await env.MSG_KV.put("ai_presets", JSON.stringify(list));
          return json({ ok: true }, 200, true);
        } catch (e) { return json({ error: `保存失败: ${e.message}` }, 500, true); }
      }
      // 删除预设（管理员）
      if (path === "/api/ai/presets" && request.method === "DELETE") {
        const auth = await getAuth(request, env);
        if (!auth || !auth.admin) return json({ error: "需要管理员权限" }, 403, true);
        const id = url.searchParams.get("id") || "";
        if (!id) return json({ error: "缺少预设 id" }, 400, true);
        const list = (await env.MSG_KV.get("ai_presets", "json")) || [];
        const next = list.filter(p => p.id !== id);
        if (next.length === list.length) return json({ error: "预设不存在" }, 404, true);
        await env.MSG_KV.put("ai_presets", JSON.stringify(next));
        return json({ ok: true }, 200, true);
      }
      // 聊天代理（登录可用；预设模式用站长 Key，个人模式用用户自带 Key）
      if (path === "/api/ai/chat" && request.method === "POST") {
        const auth = await getAuth(request, env);
        if (!auth) return json({ error: "未登录" }, 401, true);
        try {
          const body = await request.json();
          const messages = body.messages;
          if (!Array.isArray(messages) || !messages.length) return json({ error: "消息不能为空" }, 400, true);
          const msgSafe = messages.slice(-20).map(m => ({ role: String(m.role || "user").slice(0, 10), content: String(m.content || "").slice(0, 8000) }));
          let baseURL, model, apiKey;
          if (body.preset_id) {
            const list = (await env.MSG_KV.get("ai_presets", "json")) || [];
            const p = list.find(x => x.id === body.preset_id);
            if (!p) return json({ error: "预设模型不存在" }, 404, true);
            baseURL = p.baseURL; model = p.model; apiKey = p.key;
          } else {
            baseURL = String(body.baseURL || "").trim();
            model = String(body.model || "").trim();
            apiKey = String(body.key || "").trim();
            if (!baseURL || !model || !apiKey) return json({ error: "请提供 API 地址、模型和 Key" }, 400, true);
            if (!/^https:\/\//.test(baseURL)) return json({ error: "API 地址必须是 https 链接" }, 400, true);
          }
          const up = await fetch(baseURL.replace(/\/+$/, "") + "/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
            body: JSON.stringify({ model, messages: msgSafe, temperature: typeof body.temperature === "number" ? body.temperature : 0.7, stream: false })
          });
          const data = await up.json().catch(() => ({}));
          if (!up.ok) {
            const msg = data.error && data.error.message ? data.error.message : JSON.stringify(data).slice(0, 200);
            return json({ error: `上游错误 ${up.status}: ${msg}` }, 502, true);
          }
          const content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
          return json({ ok: true, content }, 200, true);
        } catch (e) { return json({ error: `代理失败: ${e.message}` }, 500, true); }
      }
      return json({ error: "method not allowed" }, 405, true);
    }

    // ---------- 静态资源 ----------
    // 注意：此处不再对返回的 HTML 做运行时字符串改写。
    // 之前 /game 分支会把 fc.appendChild(player) 删掉、再尝试用另一条规则补回，
    // 而那条规则匹配的 player.setAttribute("src", url) 在源码里并不存在（源码是 player.src = url），
    // 导致播放器永远没有插入 DOM —— Flash 游戏 100% 黑屏。页面行为请以 game.html 源码为准。
    return serveAsset(request, env, path);
  }
};

// 站内真实存在的页面路径（含无扩展名路由与其 .html 形式）
// 不在集合内的 HTML 路径，若 ASSETS 仍返回 200 + text/html，
// 说明是 Pages 的"未知路径回落首页"（无限软 404），需改成真 404。
const KNOWN_PAGE_PATHS = new Set([
  "/", "/index.html",
  "/login", "/login.html",
  "/tools", "/tools.html",
  "/media", "/media.html",
  "/guestbook", "/guestbook.html",
  "/account", "/account.html",
  "/ai-admin", "/ai-admin.html",
  "/game", "/game.html",
  "/game2048", "/game2048.html",
  "/minesweeper", "/minesweeper.html",
  "/snake", "/snake.html",
  "/minecraft", "/minecraft.html",
  "/minecraft-1122", "/minecraft-1122.html",
  "/minecraft-125", "/minecraft-125.html",
  "/minecraft-classic", "/minecraft-classic.html"
]);

// 无论如何都不参与登录门禁的路径（门禁正则见 fetch 开头，此处仅作说明）
// 说明：/robots.txt 与 /404.html 都不匹配门禁正则，因此天然不会被拦截。

const NOINDEX_HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

// HTML 响应统一补安全头 + noindex（登录门禁站兜底，防止被误收录）
function withNoindex(resp) {
  const h = new Headers(resp.headers);
  h.set("X-Robots-Tag", "noindex, nofollow");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "same-origin");
  return h;
}

// 真 404 响应：优先返回 /404.html 的内容；取不到（或该文件尚未创建、
// 又被回落成首页）则返回纯文本，绝不抛异常。
async function notFoundResponse(url, env, fallbackBody) {
  let body = "404 Not Found";
  let type = "text/plain; charset=utf-8";
  try {
    const nf = await env.ASSETS.fetch(new Request(new URL("/404.html", url).toString(), { method: "GET" }));
    if (nf.ok && (nf.headers.get("Content-Type") || "").includes("text/html")) {
      const html = await nf.text();
      // 与回落内容完全一致 => /404.html 也不存在，Pages 又把它回落成了首页
      if (html && html !== fallbackBody) {
        body = html;
        type = "text/html; charset=utf-8";
      }
    }
  } catch (e) {
    // 忽略：保持纯文本兜底
  }
  return new Response(body, {
    status: 404,
    headers: { "Content-Type": type, "Cache-Control": "no-store", ...SECURITY_HEADERS, ...NOINDEX_HEADERS }
  });
}

// 统一出口：静态资源 + HTML 加 noindex + 软 404 兜底
async function serveAsset(request, env, path) {
  const resp = await env.ASSETS.fetch(request);
  const ct = resp.headers.get("Content-Type") || "";
  // 非 HTML（图片 / JS / CSS / JSON 等）原样返回
  if (!ct.includes("text/html")) return resp;

  // 无 body 的请求（HEAD 等）只补响应头
  if (request.method !== "GET") {
    return new Response(null, { status: resp.status, statusText: resp.statusText, headers: withNoindex(resp) });
  }

  const body = await resp.text();

  // 到这里 Content-Type 一定是 text/html：真实静态资源（.js/.css/.jpg/.json/.txt…）
  // 不会返回 text/html，所以无需再按扩展名分流。
  // 因此：路径不在已知页面集合内 且 仍返回 200 + HTML => 就是 Pages 回落首页，改判真 404。
  // （/robots.txt、/404.html 若文件不存在，同样会回落，这里一并按 404 处理，避免软 404。）
  if (resp.status === 200 && !KNOWN_PAGE_PATHS.has(path)) {
    return notFoundResponse(new URL(request.url), env, body);
  }

  return new Response(body, { status: resp.status, statusText: resp.statusText, headers: withNoindex(resp) });
}
