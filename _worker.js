// Cloudflare Pages 单文件 Worker 模式（advanced mode）
// 处理：静态资源 + /api/games + /api/swf（大 SWF 转发，私有 Release + Token）
//
// 数据源：唯一权威是仓库根目录的 games.json（静态资源），由 loadGames() 读取并缓存。

// 游戏数据单源化：唯一数据源是仓库里的 /games.json（静态资源），Worker 里不再内嵌数组。
// 新增游戏只改 games.json 一处；/api/games（给首页和播放页）与 /api/swf（找资产 id）都读它。
//
// 缓存分两层，都是 module 级（isolate 内有效，isolate 被回收后自动重建）：
//   gamesCache      —— 解析后的数组，给 /api/swf 的 find 用
//   gamesJsonCache  —— 预序列化字符串，给 /api/games 直接当响应体用
// 预序列化是为了让每个 /api/games 请求只做一次 Response 构造，不再重复 JSON.stringify
// （9 条数据虽小，但这个接口是首页与播放页的必经之路）。
const GAMES_CACHE_TTL = 60000; // 与响应头 max-age=60 对齐
let gamesCache = null;
let gamesJsonCache = null;
let gamesCacheAt = 0;

async function loadGames(url, env) {
  const now = Date.now();
  if (gamesCache && gamesJsonCache && now - gamesCacheAt < GAMES_CACHE_TTL) return gamesCache;
  const res = await env.ASSETS.fetch(new Request(new URL("/games.json", url).toString(), { method: "GET" }));
  if (!res.ok) throw new Error("games.json HTTP " + res.status);
  const arr = JSON.parse(await res.text());
  if (!Array.isArray(arr)) throw new Error("games.json 不是数组");
  // 只有完整解析成功才覆盖旧缓存：刷新失败时下面的调用方还能用旧数据兜底
  gamesCache = arr;
  gamesJsonCache = JSON.stringify(arr);
  gamesCacheAt = now;
  return arr;
}

// 私有仓库 Release（不公开，需 Token 访问）
// GitHub 私有 Release 资产必须走 API 资产端点（releases/download 对 fine-grained token 返回 404）
const ASSET_API = "https://api.github.com/repos/snowandstar/games-assets/releases/assets";
const ASSET_IDS = {
  "bh32.swf": 629342885,
  "bh33.swf": 629342897
};

// CSP（折中版，先 Report-Only）。全站大量内联 <style>/<script>，Ruffle 还要 WASM 与 blob worker，
// 严格 CSP 一上就白屏，所以每条非常规指令都是有具体理由才加的：
//   'unsafe-inline'(script/style)  —— 每个页面都是内联 CSS + 内联 JS（首页 CSS/JS 全内联）
//                                     少了直接白屏
//   'wasm-unsafe-eval'             —— Ruffle 0.6 用 WebAssembly 跑 SWF，少了所有 Flash 页黑屏
//   worker-src blob:               —— Ruffle 用 blob worker
//   cdn.jsdelivr.net(script/connect)
//                                  —— game.html 拉 ruffle.js、tools.html 拉 qrcodejs/marked，
//                                     Ruffle 运行时还要从同一个 CDN 拉 .wasm
//   frame-src 4m8dv3g0c7b16.doubao.link
//                                  —— 首页/AI 助手是妙搭的跨站 iframe，少了 AI 面板空白
//   connect-src https:             —— 用户自带 Key 的模式下 API 地址由用户填，无法穷举白名单
// 转正路径（不要一步上正式）：
//   1) 先用 Content-Security-Policy-Report-Only 跑 24 小时，看控制台/上报里的违规；
//   2) 人工验四个场景：Flash 页 /game?id=、AI iframe(/ai-admin)、工具箱 /tools、4 个 minecraft 大包；
//   3) 全绿后再把同样的值换到 Content-Security-Policy 头（只改头名，值不动）。
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join("; ");

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Site-Version": "2026-10-18-wai", // 部署标记：验证 Workers AI 绑定是否随部署生效
  // 不用 same-origin：它连站内跳外链都不带 referrer，来源判断会失真
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy-Report-Only": CSP_REPORT_ONLY
};

// AI 助手已经改成站内页面直连（同源 fetch），不再需要跨域头。
// 第三个参数 cors 保留只是为了不动下面二十多个调用点，传什么都不产生效果。
function json(data, status, cors) {
  void cors;
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS
    }
  });
}

// ---------- 用户自带 Key 时的 SSRF 拦截 ----------
// /api/ai/chat 允许用户填自己的 baseURL，等于给了「让 Worker 去发一个请求」的能力，
// 所以必须拦内网与本机地址，否则能拿它探 Cloudflare 边缘能看到的内部服务。
//
// 局限（如实写，不要假装完全防住）：
//   1) Worker 没有 DNS resolve API，只能按「主机名字符串 + 字面量 IP 段」判断。
//      所以「域名 A 记录指向内网」（http://internal.evil.com/ → 10.x）挡不住。
//   2) DNS rebinding 挡不住：校验时解析到公网 IP、真正 fetch 时再解析到内网；
//      因为没有独立 resolver，无法把「校验用的 IP」固定给「请求用的连接」。
//   要挡死这两条得上 Durable Object 或自建 resolver，这个体量不值得。
//
//   反过来有个意外收获：WHATWG URL 解析器会把十进制 / 十六进制 / 八进制 / 短写的 IPv4
//   归一化成点分十进制（实测 https://2130706433/ 与 https://127.1/ 的 hostname 都是 127.0.0.1），
//   所以这几类变形不需要自己处理，交给 new URL() 就行。
//   （该实测在 Node 22 上做的；Cloudflare Worker 用的是同一套 WHATWG URL 规范，预期一致，
//    但我没有 Worker 运行时可验证，属未验证项。）
function isPrivateHost(hostname) {
  const s = String(hostname || "").trim().toLowerCase().replace(/\.$/, ""); // 去掉根点：localhost. == localhost
  if (!s) return true;
  if (s === "localhost" || s.endsWith(".localhost")) return true;
  if (s.endsWith(".local") || s.endsWith(".internal")) return true;
  if (s === "[::1]" || s === "[::]") return true;
  if (s.startsWith("[")) {
    // IPv4-mapped IPv6：URL 解析器会把 [::ffff:127.0.0.1] 归一化成 [::ffff:7f00:1]
    const mapped = s.slice(1, -1).match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (!mapped) return false; // 其他 IPv6 字面量按公开处理
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return isPrivateV4((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff);
  }
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false; // 域名按公开处理
  return isPrivateV4(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));
}
function isPrivateV4(a, b, c, d) {
  if ([a, b, c, d].some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true; // 非法就按危险处理
  if (a === 0) return true;          // 0.0.0.0/8
  if (a === 127) return true;        // 127.0.0.0/8 回环
  if (a === 10) return true;         // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;          // 192.168.0.0/16
  if (a === 169 && b === 254) return true;          // 169.254.0.0/16 链路本地（含云厂商元数据端点）
  return false;
}
// 返回 null 表示放行，否则返回可直接 return 的错误响应
function ssrfCheck(baseURL) {
  if (!/^https:\/\//.test(baseURL)) return json({ error: "API 地址必须是 https 链接", code: "invalid_base_url" }, 400, true);
  let host = "";
  try {
    host = new URL(baseURL).hostname;
  } catch (e) {
    return json({ error: "API 地址格式不正确", code: "invalid_base_url" }, 400, true);
  }
  if (isPrivateHost(host)) {
    return json({ error: "API 地址不能是内网或本机地址", code: "invalid_base_url" }, 400, true);
  }
  return null;
}

// ---------- AI 对话限流 ----------
// 四个计数键，阈值由 KV 免费写额度倒推：每次调用写 4 个键，免费额度 1000 写/天
// → 全站日上限 300（1200 写）是硬约束，不是拍脑袋。升级套餐后把 AI_GLOBAL_DAY 提到 2000 即可。
const AI_USER_HOUR = 30;
const AI_USER_DAY = 100;
const AI_IP_HOUR = 60;
const AI_GLOBAL_DAY = 300;
// 计数是近似限流：KV 最终一致，并发下可能多放 1–2 次。精确限流要 Durable Object，这个量级不值得。
function ai429(message, code, window, resetAt) {
  return json({ error: message, code, ...(window ? { window } : {}), resetAt }, 429, true);
}
// 返回 null 表示放行；否则返回 429 响应
async function aiRateCheck(env, username, ip) {
  const now = Date.now();
  const p = cnParts(now);
  const kUH = `aiq:uh:${username}:${p.ymdh}`;
  const kUD = `aiq:u:${username}:${p.ymd}`;
  const kIH = `aiq:ip:${ip}:${p.ymdh}`;
  const kAD = `aiq:all:${p.ymd}`;
  // 先读后写：任一超限立刻返回，不要为了“记一次”先写
  const [uh, ud, ih, ad] = await Promise.all([
    env.MSG_KV.get(kUH), env.MSG_KV.get(kUD), env.MSG_KV.get(kIH), env.MSG_KV.get(kAD)
  ]);
  const nUH = parseInt(uh || "0", 10);
  const nUD = parseInt(ud || "0", 10);
  const nIH = parseInt(ih || "0", 10);
  const nAD = parseInt(ad || "0", 10);
  // 判定顺序：全站日 → 用户日 → 用户小时 → IP 小时。
  // 用户小时与用户日同时命中时回日档：当天已用完的人不该被告知“20 分钟后再试”，
  // 否则他白等一轮又撞墙。
  if (nAD >= AI_GLOBAL_DAY) return ai429("今天全站的额度用完了，明天再来", "global_quota_exceeded", "", p.nextDay);
  if (nUD >= AI_USER_DAY) return ai429("今天的次数用完了，明天再来", "user_rate_limited", "day", p.nextDay);
  if (nUH >= AI_USER_HOUR) return ai429("这一小时聊得有点多，歇一会儿再来", "user_rate_limited", "hour", p.nextHour);
  if (nIH >= AI_IP_HOUR) return ai429("这个网络这一小时聊得有点多，歇一会儿再来", "ip_rate_limited", "hour", p.nextHour);
  // 放行：计数写入不阻塞响应（写失败就当没记，宁可放过一次，也别让用户白等）
  return { kUH, kUD, kIH, kAD, nUH, nUD, nIH, nAD };
}
function aiRateCommit(env, ctx, s) {
  const w = [
    env.MSG_KV.put(s.kUH, String(s.nUH + 1), { expirationTtl: 3600 }),
    env.MSG_KV.put(s.kUD, String(s.nUD + 1), { expirationTtl: 86400 }),
    env.MSG_KV.put(s.kIH, String(s.nIH + 1), { expirationTtl: 3600 }),
    env.MSG_KV.put(s.kAD, String(s.nAD + 1), { expirationTtl: 86400 })
  ];
  ctx.waitUntil(Promise.all(w).catch(() => {}));
}

// ---------- 留言板：一条留言一个 KV 键 ----------
// 旧实现是 msgs 单键 read-modify-write（get → push → put）：两个并发请求读到同一份数组，
// 后写的覆盖先写的，必丢数据；change-username 还在同一个键上做第二次 RMW，风险叠加。
// 改成单键单写后，写操作之间不再有共享状态。
const MSG_TTL = 365 * 86400;
const MSG_RATE_USER_MAX = 8;      // 同一用户 10 分钟 8 条
const MSG_RATE_USER_WIN = 600000; // 10 分钟
const MSG_RATE_DAY_MAX = 200;     // 全站每天 200 条
const MSG_CACHE_TTL = 15;         // 列表 15 秒边缘缓存

// id = 倒序时间戳(13 位补零) + '-' + 随机 3 字节 hex。
// 倒序时间戳做前缀，KV.list 的字典序天然就是时间倒序，取最近 N 条不需要再排序。
function newMsgId(time) {
  return String(9999999999999 - (time || Date.now())).padStart(13, "0") + "-" + randHex(3);
}
// 存量迁移：旧 msgs 里的 id 已是 base36 时间戳，直接复用（保证顺序不乱）；缺失则补当前时间
function legacyMsgId(m) {
  if (m && m.id && /^[a-z0-9-]{4,40}$/i.test(m.id)) return String(m.id);
  return newMsgId(m && m.time ? m.time : undefined);
}
async function migrateMsgs(env) {
  if (await env.MSG_KV.get("migrated:msgs2")) return;
  const old = (await env.MSG_KV.get("msgs", "json")) || [];
  if (Array.isArray(old) && old.length) {
    await Promise.all(old.map(m =>
      env.MSG_KV.put("msg:" + legacyMsgId(m), JSON.stringify({
        id: legacyMsgId(m), name: m.name || "匿名", avatar: m.avatar || "", text: m.text || "", time: m.time || Date.now()
      }), { expirationTtl: MSG_TTL })
    ));
  }
  await env.MSG_KV.put("migrated:msgs2", String(Date.now()));
}
// 读列表：新键（倒序前 50）+ 旧 msgs（若还在）合并。旧键保留 30 天不删，防回填失败丢留言。
async function readMsgs(env, limit) {
  const list = await env.MSG_KV.list({ prefix: "msg:", limit });
  const items = await Promise.all(list.keys.map(k => env.MSG_KV.get(k.name, "json").catch(() => null)));
  const out = items.filter(m => m && m.id);
  const legacy = (await env.MSG_KV.get("msgs", "json")) || [];
  if (Array.isArray(legacy) && legacy.length) {
    const seen = new Set(out.map(m => m.id));
    for (const m of legacy) {
      const id = legacyMsgId(m);
      if (!seen.has(id)) { seen.add(id); out.push({ ...m, id }); }
    }
    // 迁移期两套 id 混在一起，按 time 倒序排一次（稳定期新键已有序，这次排序几乎不耗时）
    out.sort((a, b) => (b.time || 0) - (a.time || 0));
  }
  return out.slice(0, limit);
}
// UTC+8 的“墙上时间” —— 日键后缀与 resetAt 必须用同一套计算，
// 否则会出现「键还在限流、resetAt 却已过期」的矛盾。
// 禁止用 new Date().getHours() + 8：环境时区不可依赖，且不取模跨零点必错（22 点算成 30 点）。
function cnParts(now) {
  const cn = new Date((now || Date.now()) + 8 * 3600 * 1000);
  const iso = cn.toISOString();
  return {
    ymd: iso.slice(0, 10).replace(/-/g, ""),
    ymdh: iso.slice(0, 13).replace(/[-T]/g, ""),
    // 次日 00:00(UTC+8) 的 epoch ms：用 Date.UTC 处理月末/跨年进位，再减 8 小时回落
    nextDay: Date.UTC(cn.getUTCFullYear(), cn.getUTCMonth(), cn.getUTCDate() + 1) - 8 * 3600 * 1000,
    // 下一个整点是绝对时刻，与时区无关
    nextHour: Math.ceil((now || Date.now()) / 3600000) * 3600000
  };
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
// 读 cookie。用 split 而不是正则：正则里拼 name 既没必要，也容易在特殊字符上出岔子。
// decodeURIComponent 对非法百分号序列会抛错（例如手工构造 "ghub_gate=%"），
// 一旦抛出就是整站 500，所以这里必须吞掉异常按“没有 cookie”处理。
function readCookie(request, name) {
  const c = request.headers.get("Cookie") || "";
  for (const part of c.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    const raw = part.slice(i + 1).trim();
    try { return decodeURIComponent(raw); } catch (e) { return ""; }
  }
  return "";
}

// ---------- 门禁 cookie（HMAC 签名，页面路径 0 次 KV 读） ----------
// 格式：base64url(username).<exp_ms>.<base64url(HMAC-SHA256(username + "." + exp, SESSION_SECRET))>
// 页面门禁只决定“能不能看到页面壳”；写操作与权限仍走 getAuth() 的 KV 会话（sess:<token>），
// 所以轮换 SESSION_SECRET 或删 sess: 依然能即时撤销 API 权限。
const GATE_TTL_SEC = 3600 * 24 * 30; // 30 天，与 sess: 一致

function b64uEncode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uDecode(str) {
  const t = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const pad = t.length % 4 === 0 ? "" : "=".repeat(4 - (t.length % 4));
  const bin = atob(t + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function hmacSha256(payload, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}
// 常数时间比较（字节级）。长度不等直接 false：HMAC-SHA256 长度恒为 32，
// 长度不等必然是伪造值，提前返回不会泄漏比长度更多的信息。
function constEqBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
// 签发票据；SESSION_SECRET 未配置时返回 null（调用方据此选择降级路径）
async function issueGate(username, env) {
  if (!env.SESSION_SECRET) return null;
  const exp = Date.now() + GATE_TTL_SEC * 1000;
  const sig = await hmacSha256(username + "." + exp, env.SESSION_SECRET);
  return `${b64uEncode(new TextEncoder().encode(username))}.${exp}.${b64uEncode(sig)}`;
}
// 校验票据；通过返回 username，否则 null。未配置 SESSION_SECRET 恒返回 null（不签发也不校验）
async function verifyGate(value, env) {
  if (!env.SESSION_SECRET || !value) return null;
  const parts = String(value).split(".");
  if (parts.length !== 3) return null;
  let username = "";
  let sig = null;
  try {
    username = new TextDecoder().decode(b64uDecode(parts[0]));
    sig = b64uDecode(parts[2]);
  } catch (e) {
    return null; // 非法 base64 / 非法 UTF-8
  }
  if (!username) return null;
  // exp 必须是纯数字：Number("1e9") 或含空白都会通过 Number()，用正则卡死格式
  if (!/^\d{1,15}$/.test(parts[1])) return null;
  const exp = Number(parts[1]);
  const expect = await hmacSha256(username + "." + exp, env.SESSION_SECRET);
  if (!constEqBytes(sig, expect)) return null;
  if (Date.now() >= exp) return null;
  return username;
}
// 哪些路径需要门禁
// 1) 首页两个形式；2) 白名单页面（正则有右边界，见 fetch 内注释）；
// 3) 排除带非 html 扩展名的静态资源（.json/.svg/.jpg/.swf…）——注意不能一刀切排除所有带扩展名的
//    路径，否则 /minecraft.html 这种真页面会被绕过，门禁直接失效。
const GATE_PAGE_RE = /^\/(tools|media|guestbook|game|game2048|minesweeper|snake|minecraft|minecraft-1122|minecraft-125|minecraft-classic|account|ai-admin|admin|chat|games)(?:[\/\?#.]|$)/;
const GATE_STATIC_EXT_RE = /\.(?!html?$)[a-z0-9]{1,8}$/i;
function needsGate(path) {
  if (path === "/" || path === "/index.html") return true;
  if (GATE_STATIC_EXT_RE.test(path)) return false;
  return GATE_PAGE_RE.test(path);
}
// next 参数校验：只接受站内相对路径，防开放重定向
function safeNext(v) {
  if (typeof v !== "string" || !v) return "/";
  if (!v.startsWith("/") || v.startsWith("//")) return "/";
  if (v.indexOf("\\") !== -1) return "/";
  if (/[\x00-\x1f\x7f]/.test(v)) return "/"; // 换行/回车会拆出走私头
  if (v.length > 200) return "/";
  return v;
}
// 统一的 Cookie 串：HttpOnly + Secure + SameSite=Lax
// - HttpOnly：前端只用 localStorage 的 token 调 API，不读 cookie，零副作用白赚一层 XSS 防护
// - Secure：全站 HTTPS，无条件加
// - SameSite=Lax：AI iframe 是跨站的，但它走 Bearer 不用 cookie，不受影响
function cookieStr(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
function clearCookieStr(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
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

// ---------- 站长看板：访问统计（内存攒批 + 合并写入） ----------
// KV 免费写额度 1000 次/天，逐 PV 一写半天就打满，所以统计必须在 isolate 内存里攒批：
// 攒满 5 分钟才 read-modify-write 合并写回一个日键（stat:d:<ymd>）。
// 代价与边界（如实写，不假装精确）：
//   1) isolate 被回收时没攒满 5 分钟的那一小批会丢——看板是趋势参考，不是精确账本；
//   2) 多 isolate 并发 flush 时 KV 最终一致，可能互相覆盖丢一点计数；
//   3) UV 用「当日 + IP 的 SHA-256 前 12 位」估计，不跨天去重，也不是严格意义上的用户数。
const STAT_FLUSH_MS = 5 * 60 * 1000;
const STAT_TTL_SEC = 90 * 86400; // 日键保留 90 天，靠 TTL 自动清，不占删除额度
const STAT_UV_CAP = 1000;        // 每日 UV 哈希集合上限，防止日键无限膨胀
const STAT_READ_DAYS = 14;       // 看板一次读最近 14 天
let statBuf = null;              // { ymd, pv, uv:[哈希], plays:{游戏id:次数} }
let statFlushAt = 0;

async function statIpHash(ip, ymd) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + "|" + ymd));
  return [...new Uint8Array(d).slice(0, 6)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function statFlush(env) {
  const buf = statBuf;
  if (!buf) return;
  statBuf = null;
  statFlushAt = 0;
  const key = "stat:d:" + buf.ymd;
  const cur = (await env.MSG_KV.get(key, "json")) || { pv: 0, uv: [], plays: {} };
  cur.pv = (parseInt(cur.pv, 10) || 0) + buf.pv;
  const seen = new Set(Array.isArray(cur.uv) ? cur.uv : []);
  for (const h of buf.uv) {
    if (seen.size >= STAT_UV_CAP) break;
    seen.add(h);
  }
  cur.uv = [...seen];
  cur.plays = cur.plays && typeof cur.plays === "object" ? cur.plays : {};
  for (const [id, n] of Object.entries(buf.plays)) {
    cur.plays[id] = (parseInt(cur.plays[id], 10) || 0) + n;
  }
  await env.MSG_KV.put(key, JSON.stringify(cur), { expirationTtl: STAT_TTL_SEC });
}

async function statRecord(env, ctx, ip, play) {
  const p = cnParts(Date.now());
  if (!statBuf || statBuf.ymd !== p.ymd) {
    statBuf = { ymd: p.ymd, pv: 0, uv: [], plays: {} };
    statFlushAt = Date.now();
  }
  statBuf.pv += 1;
  statBuf.uv.push(await statIpHash(ip, p.ymd));
  if (play) statBuf.plays[play] = (statBuf.plays[play] || 0) + 1;
  if (Date.now() - statFlushAt >= STAT_FLUSH_MS) {
    // 先推进时间戳再写：flush 失败时不要让后续每个请求都反复重试
    statFlushAt = Date.now();
    ctx.waitUntil(statFlush(env).catch(() => {}));
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 同源调用不会发预检；这里保留 204 只是为了让浏览器里的旧预检不报错
    if (request.method === "OPTIONS" && path.startsWith("/api/ai/")) {
      return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    }

    // 整站登录门禁：除登录页与 API 外，未登录一律跳转登录页
    // 路径判定见 needsGate()（白名单正则的右边界说明在那里）。
    if (needsGate(path)) {
      const gate = readCookie(request, "ghub_gate");
      let pass = false;
      if (env.SESSION_SECRET) {
        // 主路径：HMAC 校验，纯 CPU，0 次 KV 读
        pass = !!(await verifyGate(gate, env));
      } else {
        // 降级路径：SESSION_SECRET 未配置时退回 KV 会话校验（旧行为）。
        // 既不因为缺配置就放行全部请求，也不返回 500。
        const t = readCookie(request, "ghub_token");
        if (t) {
          const sess = await env.MSG_KV.get("sess:" + t, "json");
          pass = !!(sess && sess.exp && sess.exp >= Date.now());
        }
      }
      if (!pass) {
        // 一跳到位：直接指到 /login（不再写 /login.html，Pages 会 308 到 /login，等于多一跳）
        const next = safeNext(path + url.search);
        return new Response(null, {
          status: 302,
          headers: {
            "Location": "/login?next=" + encodeURIComponent(next),
            "Cache-Control": "no-store",
            ...SECURITY_HEADERS
          }
        });
      }
    }

    // 游戏列表接口（数据源 = /games.json，见 loadGames）
    if (path === "/api/games") {
      try {
        await loadGames(url, env);
      } catch (e) {
        // 刷新失败时只要有旧缓存就继续用旧的：首页空白比数据旧 60 秒严重得多
        if (!gamesJsonCache) {
          console.error("[games] games.json 读取失败: " + (e && e.message));
          return json({ error: "游戏数据暂时不可用", code: "data_unavailable" }, 500);
        }
        console.error("[games] games.json 刷新失败，沿用旧缓存: " + (e && e.message));
      }
      // 契约 §4.0：/api/games 是唯一允许被缓存的 API（no-store 的例外）
      return new Response(gamesJsonCache, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=60",
          ...SECURITY_HEADERS
        }
      });
    }

    // 大 SWF 转发（私有 GitHub Release，带 Token）
    if (path === "/api/swf") {
      const id = url.searchParams.get("id") || "";
      let game = null;
      try {
        const list = await loadGames(url, env);
        game = list.find(g => g.id === id) || null;
      } catch (e) {
        console.error("[swf] games.json 读取失败: " + (e && e.message));
        return json({ error: "游戏数据暂时不可用", code: "data_unavailable" }, 500);
      }
      if (!game) {
        return json({ error: "Game not found", code: "game_not_found" }, 404);
      }
      const token = env.GH_TOKEN || "";
      if (!token) {
        return json({ error: "GH_TOKEN not configured", code: "gh_token_missing" }, 500);
      }
      // games.json 里的 swf 是路径（"/swf/bh32.swf"），ASSET_IDS 的键是裸文件名。
      // 取 basename 再查，两种写法都能对上——否则换数据源那天 Flash 游戏会集体 404。
      const swfName = String(game.swf || "").split("/").pop();
      const assetId = ASSET_IDS[swfName];
      if (!assetId) {
        return json({ error: "Asset id not found", code: "asset_not_found" }, 404);
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
      // 管理员由 setup_code 决定，不再是“第一个注册的账号自动成为管理员”。
      // 旧逻辑用 KV.list({prefix:"user:"}).keys.length === 0 判首注册者，两个问题：
      //   1) 任何人只要在站长之前注册就永久拿到 admin（抢注）；
      //   2) 每次注册都扫一遍全表（KV list 有游标开销，用户多了会翻页）。
      // 未配置 ADMIN_SETUP_CODE 时一律 admin:false（安全默认：宁可没有管理员，也不送管理员）。
      // 存量 user: 记录里已有的 admin:true 不受影响（本接口只在新建时决定）。
      const setup = String(body && body.setup_code || "");
      if (setup && !env.ADMIN_SETUP_CODE) {
        return json({ error: "本站未开启管理员自助注册", code: "invalid_setup_code" }, 400);
      }
      if (setup && !constEq(setup, env.ADMIN_SETUP_CODE)) {
        return json({ error: "管理员邀请码不正确", code: "invalid_setup_code" }, 400);
      }
      const isAdmin = !!env.ADMIN_SETUP_CODE && constEq(setup, env.ADMIN_SETUP_CODE);
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
      // 门禁 cookie 与 KV 会话并行签发：页面门禁认前者，API 权限仍认后者
      const gate = await issueGate(username, env);
      const h = new Headers({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...SECURITY_HEADERS
      });
      h.append("Set-Cookie", cookieStr("ghub_token", token, SESSION_TTL));
      if (gate) h.append("Set-Cookie", cookieStr("ghub_gate", gate, GATE_TTL_SEC));
      return new Response(JSON.stringify({ ok: true, token, username, admin: !!rec.admin, avatar: rec.avatar || "" }), { headers: h });
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
      // 不再改写历史留言里的名字：留言存的 name 是发布时的快照。
      // 旧实现在这里对 msgs 单键做第二次 read-modify-write，和 POST /api/msg 抢同一个键，
      // 并发下会互相覆盖。代价是改名后旧留言仍显示旧名——数据完整性比显示名重要。
      // 重新签发会话（新 token 绑定新用户名）
      const oldTok = bearerToken(request);
      if (oldTok) await env.MSG_KV.delete("sess:" + oldTok);
      const token = randHex(32);
      await env.MSG_KV.put("sess:" + token, JSON.stringify({ username: nn, exp: Date.now() + SESSION_TTL * 1000 }), { expirationTtl: SESSION_TTL });
      // 门禁 cookie 同步换成新用户名（否则改名后门禁还是旧名，页面照进但 API 对不上）
      const gate = await issueGate(nn, env);
      const h2 = new Headers({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...SECURITY_HEADERS
      });
      h2.append("Set-Cookie", cookieStr("ghub_token", token, SESSION_TTL));
      if (gate) h2.append("Set-Cookie", cookieStr("ghub_gate", gate, GATE_TTL_SEC));
      return new Response(JSON.stringify({ ok: true, token, username: nn, admin: auth.admin, avatar: auth.avatar }), { headers: h2 });
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
      // 前端也可能不带 Authorization，只带 cookie，两种都要清
      const cookieTok = readCookie(request, "ghub_token");
      if (cookieTok) await env.MSG_KV.delete("sess:" + cookieTok);
      const h = new Headers({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...SECURITY_HEADERS
      });
      // 两个 cookie 都要清：只清 ghub_token 的话门禁 cookie 还在，页面看起来还是登录态
      h.append("Set-Cookie", clearCookieStr("ghub_token"));
      h.append("Set-Cookie", clearCookieStr("ghub_gate"));
      return new Response(JSON.stringify({ ok: true }), { headers: h });
    }

    // 留言板接口（一条留言一个 KV 键；发留言必须登录，管理员可删除）
    if (path === "/api/msg") {
      if (request.method === "GET") {
        // limit 默认 50、上限 50（再多也只展示一屏，且 KV 读是线性成本）
        const n = parseInt(url.searchParams.get("limit") || "50", 10);
        const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 50) : 50;
        const cacheKey = new Request(url.toString(), { method: "GET" });
        try {
          const hit = await caches.default.match(cacheKey);
          if (hit) return hit;
        } catch (e) {
          // Cache API 不可用时直接回源，不影响功能
        }
        await migrateMsgs(env);
        const list = await readMsgs(env, limit);
        // 输出归一化：补齐新字段默认值 + 截断上限，历史数据没有这些字段也不炸。
        // 置顶优先，其余按时间倒序。
        const norm = list.map(m => ({
          id: m.id,
          name: m.name || "匿名",
          avatar: m.avatar || "",
          text: m.text || "",
          time: m.time || 0,
          pinned: !!m.pinned,
          likes: Math.max(0, parseInt(m.likes, 10) || 0),
          likedBy: Array.isArray(m.likedBy) ? m.likedBy.slice(0, 200) : [],
          replies: (Array.isArray(m.replies) ? m.replies : []).slice(0, 30)
            .map(r => ({
              id: r.id, name: r.name || "匿名", avatar: r.avatar || "",
              text: r.text || "", time: r.time || 0
            })).filter(r => r.text)
        })).sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || ((b.time || 0) - (a.time || 0)));
        // 15 秒边缘缓存：把「每次刷新 50 次 KV 读」压到「每 colo 每 15 秒 50 次」。
        // 必须给 public + max-age，no-store 的响应 Cache API 不会存。
        const resp = new Response(JSON.stringify(norm), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=${MSG_CACHE_TTL}`,
            ...SECURITY_HEADERS
          }
        });
        try {
          ctx.waitUntil(caches.default.put(cacheKey, resp.clone()));
        } catch (e) {
          // 写缓存失败无所谓，下次回源
        }
        return resp;
      }
      if (request.method === "POST") {
        const auth = await getAuth(request, env);
        if (!auth) return json({ error: "请先登录再留言", code: "unauthorized" }, 401);
        try {
          const body = await request.json();
          const text = String(body.text || "").trim().slice(0, 500);
          if (!text) return json({ error: "留言内容不能为空", code: "empty_text" }, 400);
          // now 必须在回复分支之前声明：replyTo 分支的 newMsgId(now)/time:now 都要用它，
          // 声明放后面会踩 TDZ（一回复就 ReferenceError → 500）
          const now = Date.now();
          // 回复模式：带 replyTo 就是楼中楼回复，正文上限收到 200 字
          const replyTo = String(body.replyTo || "").trim();
          if (replyTo) {
            const parent = await env.MSG_KV.get("msg:" + replyTo, "json");
            if (!parent) return json({ error: "回复的留言不存在或已删除", code: "parent_not_found" }, 404);
            const replies = Array.isArray(parent.replies) ? parent.replies : [];
            if (replies.length >= 30) {
              return json({ error: "这条留言的回复已达上限", code: "replies_full" }, 400);
            }
            const rid = newMsgId(now);
            replies.push({ id: rid, name: auth.username, avatar: auth.avatar || "", text: text.slice(0, 200), time: now });
            parent.replies = replies;
            await env.MSG_KV.put("msg:" + replyTo, JSON.stringify(parent), { expirationTtl: MSG_TTL });
            try {
              ctx.waitUntil(caches.default.delete(new URL("/api/msg", url).toString()));
            } catch (e) { /* 缓存清不掉最多晚 15 秒 */ }
            return json({ ok: true, id: replyTo, replyId: rid });
          }
          // 限流：同一用户 10 分钟 8 条、全站 200 条/天。
          // 计数键靠 TTL 自动过期，不用 delete（delete 也占 KV 免费写额度）。
          const p = cnParts(now);
          const uKey = "msgq:u:" + auth.username + ":" + Math.floor(now / MSG_RATE_USER_WIN);
          const dKey = "msgq:all:" + p.ymd;
          const [uN, dN] = await Promise.all([
            env.MSG_KV.get(uKey), env.MSG_KV.get(dKey)
          ]);
          const uCount = parseInt(uN || "0", 10);
          const dCount = parseInt(dN || "0", 10);
          if (dCount >= MSG_RATE_DAY_MAX) {
            return json({ error: "今天全站留言额度用完了，明天再来", code: "msg_rate_limited", window: "day", resetAt: p.nextDay }, 429);
          }
          if (uCount >= MSG_RATE_USER_MAX) {
            // window 用 "10m"（契约 §4.1 第 12 条），不是 AI 限流的 "hour"
            return json({ error: "留言太频繁了，歇 10 分钟再发", code: "msg_rate_limited", window: "10m", resetAt: (Math.floor(now / MSG_RATE_USER_WIN) + 1) * MSG_RATE_USER_WIN }, 429);
          }
          const id = newMsgId(now);
          const msg = { id, name: auth.username, avatar: auth.avatar || "", text, time: now };
          await env.MSG_KV.put("msg:" + id, JSON.stringify(msg), { expirationTtl: MSG_TTL });
          // 列表有 15 秒边缘缓存，不主动失效的话「刚发出去的留言要等 15 秒才出现」，
          // 用户会以为是发布失败然后重复发。这里把默认列表（无 limit 参数）的缓存删掉。
          try {
            ctx.waitUntil(caches.default.delete(new URL("/api/msg", url).toString()));
          } catch (e) {
            // 清不掉最多是旧列表多留 15 秒，不影响写入
          }
          ctx.waitUntil(Promise.all([
            env.MSG_KV.put(uKey, String(uCount + 1), { expirationTtl: 900 }),
            env.MSG_KV.put(dKey, String(dCount + 1), { expirationTtl: 86400 })
          ]));
          return json({ ok: true, id });
        } catch (e) {
          return json({ error: `留言写入失败: ${e.message}`, code: "write_failed" }, 500);
        }
      }
      if (request.method === "DELETE") {
        const auth = await getAuth(request, env);
        if (!auth) return json({ error: "请先登录", code: "unauthorized" }, 401);
        const id = url.searchParams.get("id") || "";
        if (!id) return json({ error: "缺少留言 id", code: "missing_id" }, 400);
        // 先校验存在（KV.delete 删不存在的键也返回成功，不校验的话前端永远看到“删除成功”）
        const cur = await env.MSG_KV.get("msg:" + id, "json");
        if (!cur) return json({ error: "留言不存在", code: "msg_not_found" }, 404);
        // 管理员可删任意；普通用户只能删自己发的
        if (!auth.admin && cur.name !== auth.username) {
          return json({ error: "只能删除自己的留言", code: "forbidden" }, 403);
        }
        await env.MSG_KV.delete("msg:" + id);
        // 存量 msgs 里可能还有同一条，一并去掉，避免删完又从旧键合并回来
        const legacy = (await env.MSG_KV.get("msgs", "json")) || [];
        if (Array.isArray(legacy) && legacy.some(m => legacyMsgId(m) === id)) {
          await env.MSG_KV.put("msgs", JSON.stringify(legacy.filter(m => legacyMsgId(m) !== id)));
        }
        return json({ ok: true });
      }
      return json({ error: "method not allowed", code: "method_not_allowed" }, 405);
    }

    // 点赞 / 取消点赞（登录；防手抖连点：每用户 10 分钟 20 次）
    // 点赞数与 likedBy 内联在留言记录里：个人站规模下并发丢赞可接受，
    // 换来 GET 单次调用就能带全数据（独立键方案每次要 50 次 KV 读，不划算）。
    if (path === "/api/msg/like" && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth) return json({ error: "请先登录", code: "unauthorized" }, 401);
      let body = null;
      try { body = await request.json(); } catch (e) {}
      const id = String(body && body.id || "");
      if (!id) return json({ error: "缺少留言 id", code: "missing_id" }, 400);
      const now = Date.now();
      const lkKey = "msgq:lk:" + auth.username + ":" + Math.floor(now / MSG_RATE_USER_WIN);
      const lkN = parseInt(await env.MSG_KV.get(lkKey) || "0", 10);
      if (lkN >= 20) {
        return json({ error: "操作太频繁了，歇一会儿", code: "rate_limited" }, 429);
      }
      const msg = await env.MSG_KV.get("msg:" + id, "json");
      if (!msg) return json({ error: "留言不存在", code: "msg_not_found" }, 404);
      const likedBy = Array.isArray(msg.likedBy) ? msg.likedBy : [];
      const had = likedBy.indexOf(auth.username) >= 0;
      if (had) {
        msg.likedBy = likedBy.filter(u => u !== auth.username);
        msg.likes = Math.max(0, (parseInt(msg.likes, 10) || 1) - 1);
      } else {
        if (likedBy.length >= 200) return json({ error: "这条留言的点赞已达上限", code: "likes_full" }, 400);
        likedBy.push(auth.username);
        msg.likedBy = likedBy;
        msg.likes = (parseInt(msg.likes, 10) || 0) + 1;
      }
      await env.MSG_KV.put("msg:" + id, JSON.stringify(msg), { expirationTtl: MSG_TTL });
      ctx.waitUntil(env.MSG_KV.put(lkKey, String(lkN + 1), { expirationTtl: 900 }));
      try {
        ctx.waitUntil(caches.default.delete(new URL("/api/msg", url).toString()));
      } catch (e) { /* 缓存清不掉最多晚 15 秒 */ }
      return json({ ok: true, liked: !had, likes: msg.likes });
    }

    // 置顶 / 取消置顶（管理员）
    if (path === "/api/msg/pin" && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth || !auth.admin) return json({ error: "需要管理员权限", code: "admin_required" }, 403);
      let body = null;
      try { body = await request.json(); } catch (e) {}
      const id = String(body && body.id || "");
      const pin = !!(body && body.pin);
      if (!id) return json({ error: "缺少留言 id", code: "missing_id" }, 400);
      const msg = await env.MSG_KV.get("msg:" + id, "json");
      if (!msg) return json({ error: "留言不存在", code: "msg_not_found" }, 404);
      if (pin) msg.pinned = true; else delete msg.pinned;
      await env.MSG_KV.put("msg:" + id, JSON.stringify(msg), { expirationTtl: MSG_TTL });
      try {
        ctx.waitUntil(caches.default.delete(new URL("/api/msg", url).toString()));
      } catch (e) { /* 缓存清不掉最多晚 15 秒 */ }
      return json({ ok: true, pinned: pin });
    }

    // ---------- 站长看板 ----------
    // 心跳：页面都在门禁后面，只有带有效门禁 cookie 的心跳才计数（HMAC 校验，0 次 KV 读）。
    // 响应体固定 {ok:true}，不给任何数据，避免被当成探测接口。
    if (path === "/api/stats" && request.method === "POST") {
      const g = await verifyGate(readCookie(request, "ghub_gate"), env);
      if (g) {
        let body = {};
        try { body = await request.json(); } catch (e) {}
        let play = String(body && body.play || "").slice(0, 40);
        if (play) {
          try {
            const games = await loadGames(url, env);
            // 不在游戏表里的 id 一律不记，防止拿垃圾字符串灌统计键
            if (!games.some(x => x.id === play)) play = "";
          } catch (e) { play = ""; }
        }
        ctx.waitUntil(statRecord(env, ctx, clientIP(request), play).catch(() => {}));
      }
      return json({ ok: true });
    }
    // 看板数据（管理员）：最近 14 天的 PV / UV / 游戏开局数
    if (path === "/api/stats" && request.method === "GET") {
      const auth = await getAuth(request, env);
      if (!auth || !auth.admin) return json({ error: "需要管理员权限", code: "admin_required" }, 403);
      const list = await env.MSG_KV.list({ prefix: "stat:d:" });
      // KV.list 字典序 = ymd 升序，取尾部即可，不用自己排序
      const keys = list.keys.map(k => k.name).sort().slice(-STAT_READ_DAYS);
      const days = await Promise.all(keys.map(async k => {
        const d = await env.MSG_KV.get(k, "json").catch(() => null);
        return {
          ymd: k.slice(7),
          pv: parseInt(d && d.pv, 10) || 0,
          uv: Array.isArray(d && d.uv) ? d.uv.length : 0,
          plays: (d && d.plays && typeof d.plays === "object") ? d.plays : {}
        };
      }));
      const total = { pv: 0, plays: {} };
      for (const d of days) {
        total.pv += d.pv;
        for (const [id, n] of Object.entries(d.plays)) total.plays[id] = (total.plays[id] || 0) + n;
      }
      return json({ ok: true, days, total });
    }
    // 用户列表（管理员）
    if (path === "/api/admin/users" && request.method === "GET") {
      const auth = await getAuth(request, env);
      if (!auth || !auth.admin) return json({ error: "需要管理员权限", code: "admin_required" }, 403);
      const users = [];
      let cursor;
      do {
        const page = await env.MSG_KV.list({ prefix: "user:", cursor });
        for (const k of page.keys) {
          const u = await env.MSG_KV.get(k.name, "json").catch(() => null);
          if (u) users.push({ username: k.name.slice(5), admin: !!u.admin, created: u.created || 0, avatar: u.avatar || "" });
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      users.sort((a, b) => (a.created || 0) - (b.created || 0));
      return json({ ok: true, users, me: auth.username });
    }
    // 用户管理操作（管理员）：grant 授权 / revoke 撤权 / delete 删除
    if (path === "/api/admin/users" && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth || !auth.admin) return json({ error: "需要管理员权限", code: "admin_required" }, 403);
      let body = null;
      try { body = await request.json(); } catch (e) {}
      const op = String(body && body.op || "");
      const target = String(body && body.username || "").trim();
      if (!["grant", "revoke", "delete"].includes(op)) return json({ error: "未知操作", code: "bad_op" }, 400);
      if (!target || target === auth.username) return json({ error: "不能对自己做这个操作", code: "self_forbidden" }, 400);
      const rec = await env.MSG_KV.get("user:" + target, "json");
      if (!rec) return json({ error: "用户不存在", code: "user_not_found" }, 404);
      if (op === "grant" || op === "revoke") {
        if (op === "revoke" && rec.admin) {
          // 撤销前确认这不是最后一位管理员，否则看板会被锁死在外面
          let cursor;
          let admins = 0;
          do {
            const page = await env.MSG_KV.list({ prefix: "user:", cursor });
            for (const k of page.keys) {
              const u = await env.MSG_KV.get(k.name, "json").catch(() => null);
              if (u && u.admin) admins += 1;
            }
            cursor = page.list_complete ? undefined : page.cursor;
          } while (cursor);
          if (admins <= 1) return json({ error: "这是最后一位管理员，不能撤销", code: "last_admin" }, 400);
        }
        rec.admin = op === "grant";
        await env.MSG_KV.put("user:" + target, JSON.stringify(rec));
        return json({ ok: true, admin: rec.admin });
      }
      // delete：删掉 user: 记录后 getAuth() 对该用户全部会话返回 null，会话即刻失效，
      // 不需要（也无法）枚举随机 token 的 sess: 键
      await env.MSG_KV.delete("user:" + target);
      return json({ ok: true, deleted: true });
    }
    // 维护：删除旧版留言单键 msgs（迁移完成后遗留，每次 GET /api/msg 都会白读一次）
    if (path === "/api/admin/cleanup" && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth || !auth.admin) return json({ error: "需要管理员权限", code: "admin_required" }, 403);
      const legacy = await env.MSG_KV.get("msgs", "json");
      if (legacy === null) return json({ ok: true, deleted: false, note: "旧键不存在，无需清理" });
      await env.MSG_KV.delete("msgs");
      return json({ ok: true, deleted: true });
    }

    // ===== AI 助手：预设模型管理与聊天代理（CORS 允许妙搭应用调用）=====
    if (path.startsWith("/api/ai/")) {
      // 预设模型列表（登录可见，不含 Key）
      if (path === "/api/ai/presets" && request.method === "GET") {
        const auth = await getAuth(request, env);
        if (!auth) return json({ error: "未登录" }, 401, true);
        const list = (await env.MSG_KV.get("ai_presets", "json")) || [];
        const out = list.map(p => ({ id: p.id, name: p.name, baseURL: p.baseURL, model: p.model, desc: p.desc }));
        // 站点绑定了 Workers AI 时，自动补一个免 Key 的内置免费模型（baseURL 固定为 "workers-ai"）
        if (env.AI) {
          out.unshift({ id: "cf", name: "Cloudflare 免费模型", baseURL: "workers-ai", model: "@cf/qwen/qwen3-30b-a3b-fp8", desc: "站点内置，免 Key 直接聊；能力较轻、每日额度有限" });
        }
        return json({ ok: true, presets: out }, 200, true);
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
      // 一键获取模型列表（管理员）：代理调服务商的 GET /models，
    // 浏览器直连会被 CORS 拦，所以走 Worker；地址是用户填的，照例过 SSRF 检查
    if (path === "/api/ai/models" && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth || !auth.admin) return json({ error: "需要管理员权限", code: "admin_required" }, 403, true);
      try {
        const body = await request.json();
        const baseURL = String(body.baseURL || "").trim();
        const apiKey = String(body.key || "").trim();
        if (!baseURL || !apiKey) return json({ error: "请提供 API 地址和 Key", code: "params_required" }, 400, true);
        const bad = ssrfCheck(baseURL);
        if (bad) return bad;
        const up = await fetch(baseURL.replace(/\/+$/, "") + "/models", {
          headers: { "Authorization": "Bearer " + apiKey }
        });
        const data = await up.json().catch(() => ({}));
        if (!up.ok) {
          const msg = data.error && data.error.message ? data.error.message : JSON.stringify(data).slice(0, 200);
          return json({ error: `上游错误 ${up.status}: ${msg}`, code: "upstream_error" }, 502, true);
        }
        // 兼容两种返回：OpenAI 风格 {data:[{id}]} 与简单数组 {models:[...]}
        let ids = [];
        if (Array.isArray(data.data)) ids = data.data.map(m => (m && (m.id || m.name)) || "");
        else if (Array.isArray(data.models)) ids = data.models.map(m => (typeof m === "string" ? m : (m && (m.id || m.name)) || ""));
        ids = [...new Set(ids.filter(Boolean))].sort();
        return json({ ok: true, models: ids }, 200, true);
      } catch (e) { return json({ error: `获取失败: ${e.message}`, code: "proxy_failed" }, 502, true); }
    }
    // 聊天代理（登录可用；预设模式用站长 Key，个人模式用用户自带 Key）
      if (path === "/api/ai/chat" && request.method === "POST") {
        const auth = await getAuth(request, env);
        if (!auth) return json({ error: "未登录", code: "unauthorized" }, 401, true);
        // 限流必须在读 body 之前先判：被挡的请求连解析都不会解析
        const rl = await aiRateCheck(env, auth.username, clientIP(request));
        if (rl instanceof Response) return rl;
        try {
          const body = await request.json();
          const messages = body.messages;
          if (!Array.isArray(messages) || !messages.length) return json({ error: "消息不能为空", code: "messages_required" }, 400, true);
          // 请求体上限（控成本比限流更直接）：
          //   1) 只保留最后 10 轮（原 20）
          //   2) 所有 content 字符总数 ≤8000，超出从最旧的消息开始丢
          //      —— 保留尾部而不是砍尾部：最后一条就是用户这次的问题，砍掉等于对话直接断掉
          // content 支持两种形态：字符串，或 OpenAI 多模态数组（[{type:'text'|'image_url',…}]）。
          // 数组原样透传（上游才收得了图），体积按 text 部分估算。
          const contentSize = (c) => typeof c === "string" ? c.length
            : (Array.isArray(c) ? c.reduce((s, p) => s + (p && p.type === "text" && p.text ? p.text.length : (p && p.image_url ? 800 : 0)), 0) : 0);
          let msgSafe = messages.slice(-10).map(m => ({ role: String(m.role || "user").slice(0, 10), content: m.content == null ? "" : m.content }));
          let total = msgSafe.reduce((s, m) => s + contentSize(m.content), 0);
          while (msgSafe.length > 1 && total > 8000) {
            total -= contentSize(msgSafe.shift().content);
          }
          if (total > 8000) {
            // 只剩一条还是超：字符串截尾保最新；多模态数组只留文本部分并截尾
            const c0 = msgSafe[0].content;
            msgSafe = [{
              ...msgSafe[0],
              content: typeof c0 === "string"
                ? c0.slice(-8000)
                : [{ type: "text", text: String((Array.isArray(c0) ? c0 : []).map(p => (p && p.text) || "").join("\n")).slice(-8000) }]
            }];
          }
          // max_tokens 默认 800：不传的话上游可能给到 4k，单次成本差好几倍
          const mt = Number(body.max_tokens);
          const maxTokens = Number.isFinite(mt) ? Math.min(2000, Math.max(200, Math.round(mt))) : 800;
          const tp = Number(body.temperature);
          const temperature = Number.isFinite(tp) ? Math.min(2, Math.max(0, tp)) : 0.7;
          let baseURL, model, apiKey;
          if (body.preset_id === "cf") {
            // 内置免费预设（不存 KV）：绑定 env.AI 后可用
            if (!env.AI) return json({ error: "站点未启用 Workers AI（管理员需在 Pages 设置里添加 AI 绑定）", code: "ai_binding_missing" }, 502, true);
            baseURL = "workers-ai"; model = "@cf/qwen/qwen3-30b-a3b-fp8"; apiKey = "";
          } else if (body.preset_id) {
            const list = (await env.MSG_KV.get("ai_presets", "json")) || [];
            const p = list.find(x => x.id === body.preset_id);
            if (!p) return json({ error: "预设模型不存在", code: "preset_not_found" }, 404, true);
            baseURL = p.baseURL; model = p.model; apiKey = p.key;
          } else {
            baseURL = String(body.baseURL || "").trim();
            model = String(body.model || "").trim();
            apiKey = String(body.key || "").trim();
            if (!baseURL || !model || !apiKey) return json({ error: "请提供 API 地址、模型和 Key", code: "params_required" }, 400, true);
            // 用户自带 Key 模式下地址由用户填，必须拦 SSRF（预设模式的地址是管理员填的，暂不套用，见 ssrfCheck 注释）
            const bad = ssrfCheck(baseURL);
            if (bad) return bad;
          }
          // 计数写入放到后台：请求已经放行，写失败也不该让这次对话失败
          aiRateCommit(env, ctx, rl);
          // 通用AI助手前端走 SSE 流式（body.stream === true）；站内旧 UI 走非流式 JSON
          const wantStream = body.stream === true;

          // ---- Cloudflare Workers AI 内置通道（preset baseURL === "workers-ai"）----
          // 免 Key、走站点绑定的 env.AI，按每日免费额度计费；模型名是 @cf/... 形式
          if (baseURL === "workers-ai") {
            if (!env.AI) {
              return json({ error: "站点未启用 Workers AI（管理员需在 Pages 设置里添加 AI 绑定）", code: "ai_binding_missing" }, 502, true);
            }
            // 每日硬封顶：免费额度 10k 神经元/天，这里再加一道代码层限制（2000 次/天），双保险不产生账单
            const dayKey = "wai_cnt:" + new Date().toISOString().slice(0, 10);
            const used = parseInt((await env.MSG_KV.get(dayKey)) || "0", 10);
            if (used >= 2000) {
              return json({ error: "今天的免费 AI 额度已用完（上限 2000 次/天），明天再来吧", code: "wai_daily_cap" }, 429, true);
            }
            ctx.waitUntil(env.MSG_KV.put(dayKey, String(used + 1), { expirationTtl: 172800 }).catch(() => {}));
            // Workers AI 不吃多模态数组：content 数组压成纯文本
            const cfMessages = msgSafe.map(m => ({
              role: m.role,
              content: typeof m.content === "string"
                ? m.content
                : (Array.isArray(m.content) ? m.content.map(p => (p && p.text) || "").filter(Boolean).join("\n") : String(m.content || ""))
            }));
            try {
              if (wantStream) {
                // env.AI.run(stream:true) 返回 SSE 流：data: {"response":"…"} … data: [DONE]
                const aiStream = await env.AI.run(model, { messages: cfMessages, max_tokens: maxTokens, temperature, stream: true });
                const sse = new TransformStream();
                const w = sse.writable.getWriter();
                const enc = new TextEncoder();
                ctx.waitUntil((async () => {
                  const reader = aiStream.getReader();
                  const dec = new TextDecoder();
                  let buf = "";
                  try {
                    for (;;) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      buf += dec.decode(value, { stream: true });
                      const lines = buf.split("\n");
                      buf = lines.pop() ?? "";
                      for (const line of lines) {
                        const t = line.trim();
                        if (!t.startsWith("data:")) continue;
                        const payload = t.slice(5).trim();
                        if (payload === "[DONE]") { await w.write(enc.encode("data: [DONE]\n\n")); continue; }
                        try {
                          const j = JSON.parse(payload);
                          const piece = j.response || "";
                          if (piece) await w.write(enc.encode(`data: ${JSON.stringify({ content: piece })}\n\n`));
                        } catch (e) { /* 忽略心跳 */ }
                      }
                    }
                    await w.write(enc.encode("data: [DONE]\n\n"));
                  } catch (e) {
                    try { await w.write(enc.encode(`data: ${JSON.stringify({ error: "Workers AI 中断: " + e.message })}\n\n`)); await w.write(enc.encode("data: [DONE]\n\n")); } catch (e2) {}
                  } finally { try { await w.close(); } catch (e2) {} }
                })().catch(() => {}));
                return new Response(sse.readable, {
                  status: 200,
                  headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", ...SECURITY_HEADERS }
                });
              }
              const result = await env.AI.run(model, { messages: cfMessages, max_tokens: maxTokens, temperature });
              return json({ ok: true, content: result.response || "" }, 200, true);
            } catch (e) {
              return json({ error: `Workers AI 调用失败: ${e.message}`, code: "workers_ai_failed" }, 502, true);
            }
          }

          const up = await fetch(baseURL.replace(/\/+$/, "") + "/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
            body: JSON.stringify({ model, messages: msgSafe, temperature, max_tokens: maxTokens, stream: wantStream })
          });
          if (!up.ok) {
            const data = await up.json().catch(() => ({}));
            const msg = data.error && data.error.message ? data.error.message : JSON.stringify(data).slice(0, 200);
            return json({ error: `上游错误 ${up.status}: ${msg}`, code: "upstream_error" }, 502, true);
          }
          if (!wantStream) {
            const data = await up.json().catch(() => ({}));
            const content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
            return json({ ok: true, content }, 200, true);
          }
          // SSE 透传：把上游的 OpenAI delta 流归一化成 {content: "…"} 行，
          // 前端同时兼容 OpenAI 格式和这个自定义格式，统一成后者最省事
          const sse = new TransformStream();
          const w = sse.writable.getWriter();
          const enc = new TextEncoder();
          ctx.waitUntil((async () => {
            const reader = up.body.getReader();
            const dec = new TextDecoder();
            let buf = "";
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                const lines = buf.split("\n");
                buf = lines.pop() ?? "";
                for (const line of lines) {
                  const t = line.trim();
                  if (!t.startsWith("data:")) continue;
                  const payload = t.slice(5).trim();
                  if (payload === "[DONE]") { await w.write(enc.encode("data: [DONE]\n\n")); continue; }
                  try {
                    const j = JSON.parse(payload);
                    const piece = j.choices && j.choices[0] && j.choices[0].delta ? (j.choices[0].delta.content || "") : "";
                    if (piece) await w.write(enc.encode(`data: ${JSON.stringify({ content: piece })}\n\n`));
                  } catch (e) { /* 忽略心跳等非 JSON 行 */ }
                }
              }
              await w.write(enc.encode("data: [DONE]\n\n"));
            } catch (e) {
              // 上游中断：给前端一条错误块，别让它挂着等
              try { await w.write(enc.encode(`data: ${JSON.stringify({ error: "上游连接中断: " + e.message })}\n\n`)); await w.write(enc.encode("data: [DONE]\n\n")); } catch (e2) {}
            } finally { try { await w.close(); } catch (e2) {} }
          })().catch(() => {}));
          return new Response(sse.readable, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Accel-Buffering": "no",
              ...SECURITY_HEADERS
            }
          });
        } catch (e) { return json({ error: `代理失败: ${e.message}`, code: "proxy_failed" }, 500, true); }
      }
      return json({ error: "method not allowed" }, 405, true);
    }

    // ---------- 通用AI助手（React 应用，挂在 /chat 路径） ----------
    // 应用自带 BrowserRouter（basename "/"），路由只有 /chat 与 /chat/:sessionId。
    // 静态资源 /assets/*、/icons.svg、/favicon.svg 是普通文件，走下面 serveAsset 即可；
    // 页面本体在这里改写成 chat.html，让 /chat 和刷新时的 /chat/:id 都能拿到入口。
    // /ai 是老入口习惯（老书签 / 手打地址），一律转正到 /chat，别让它落进 404。
    if (path === "/ai" || path === "/AI" || path.startsWith("/ai/") || path.startsWith("/AI/")) {
      return Response.redirect(new URL("/chat", url).toString(), 302);
    }
    if (path === "/chat" || path.startsWith("/chat/")) {
      // 关键：让 ASSETS 拉 /chat-app/（目录索引原生 200，没有 .html 的 308 归一化），
      // known-check 的 path 参数用同一路径（在 KNOWN_PAGE_PATHS 里）。
      // 注意 assets/ 与 icons.svg 在站点根（浏览器 URL 是 /chat，相对引用解析到 /assets/*）。
      return serveAsset(new Request(new URL("/chat-app/", url).toString(), request), env, "/chat-app/");
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
  "/admin", "/admin.html",
  "/chat", "/chat-app/",
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
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Content-Security-Policy-Report-Only", CSP_REPORT_ONLY);
  return h;
}

// 真 404 响应：优先返回 /404.html 的内容；取不到（或该文件尚未创建、
// 又被回落成首页）则返回纯文本，绝不抛异常。
// isSelf：请求的正是 /404.html 本身，此时 fallbackBody 就是 404 页内容，
// 不能再拿它做"是否被回落"的比对（必然相等，会误判成文件不存在）。
async function notFoundResponse(url, env, fallbackBody, isSelf) {
  let body = "404 Not Found";
  let type = "text/plain; charset=utf-8";
  try {
    const nf = await env.ASSETS.fetch(new Request(new URL("/404.html", url).toString(), { method: "GET" }));
    if (nf.ok && (nf.headers.get("Content-Type") || "").includes("text/html")) {
      const html = await nf.text();
      // 与回落内容完全一致 => /404.html 也不存在，Pages 又把它回落成了首页
      if (html && (isSelf || html !== fallbackBody)) {
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
  // /games/** 是开源 H5 游戏的多文件目录，真实存在，豁免软 404 改判。
  if (resp.status === 200 && !KNOWN_PAGE_PATHS.has(path) && !path.startsWith("/games/")) {
    return notFoundResponse(new URL(request.url), env, body, path === "/404.html");
  }

  return new Response(body, { status: resp.status, statusText: resp.statusText, headers: withNoindex(resp) });
}
