#!/usr/bin/env node
/**
 * scripts/build.mjs — games-hub 构建脚本（零依赖，Node >= 18）
 *
 * 用法：node scripts/build.mjs
 * 产出：dist/（Pages 的 Output directory）
 *
 * 只做四件事，不做别的：
 *   1. 校验 games.json（不合法就非零退出，不自动修复）
 *   2. 按 group 分组生成首页卡片，注入 index.html 的三处
 *      <!--@build:cards:mc--> / :flash--> / :quick-->
 *   3. 构建期算好首屏数字条与三个区块的计数徽章，写进 HTML
 *   4. 白名单拷贝到 dist/；4 个大包只改 <head> 元信息，流式处理
 *
 * 首页是纯静态结构（卡片在 HTML 里），不发 /api/games，没有骨架屏那一轮。
 * 占位符缺失即构建失败——宁可部署不了，也不要上线一个空首页。
 *
 * 源目录解析规则：同名文件先找 spec §8 的分层目录（src/ bundles/ data/），
 * 找不到再退回仓库根目录。目录重构前后都能跑。
 */

import { open, copyFile, mkdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

// ---------------------------------------------------------------- 常量

// 白名单：进 dist/ 的页面（16 个）
const PAGES = [
  "index.html",
  "game.html",
  "account.html",
  "login.html",
  "ai-admin.html",
  "tools.html",
  "media.html",
  "guestbook.html",
  "admin.html",
  "game2048.html",
  "minesweeper.html",
  "snake.html",
  "minecraft.html",
  "minecraft-1122.html",
  "minecraft-125.html",
  "minecraft-classic.html",
  "404.html"
];

// 白名单：进 dist/ 的其他文件
const EXTRA = [
  "_worker.js", "robots.txt", "default.svg", "bh32.jpg", "bh33.jpg", "games.json",
  // PWA
  "manifest.webmanifest", "sw.js", "offline.html", "icon-192.png", "icon-512.png"
];

// 永不进 dist/（白名单之外的一切都进不来，这里只是让构建日志说清楚）
const EXCLUDED = ["docs/", "scripts/", "_backup/", "_shots/", "dist/", "*.log"];

// 4 个大包的 <head> 元信息重写表（P0-10）
// 体积口径 MiB，与 games.json 的 size 一致
const BUNDLE_META = {
  "minecraft.html": {
    title: "我的世界 1.8.8 网页版 · games-hub",
    desc: "1.8.8 老版本，浏览器直接玩，不用下载、不用装 Java。约 14MB，第一次进要等十几秒。"
  },
  "minecraft-1122.html": {
    title: "我的世界 1.12.2 网页版 · games-hub",
    desc: "1.12.2 版本，浏览器直接玩，不用下载。约 19MB，第一次进要等半分钟左右。"
  },
  "minecraft-125.html": {
    title: "我的世界 1.2.5 网页版 · games-hub",
    desc: "早期版本，浏览器直接开。约 6MB。"
  },
  "minecraft-classic.html": {
    title: "我的世界 Classic 网页版 · games-hub",
    desc: "版本最老，浏览器直接开。约 3.6MB。"
  }
};

// 卡片封面图固有尺寸，写进 width/height 防 CLS
const IMG_SIZE = {
  "/default.svg": [64, 64],
  "/bh32.jpg": [72, 72],
  "/bh33.jpg": [72, 72]
};
const IMG_SIZE_FALLBACK = [400, 300];

// 副文案缺省值：games.json 里有 desc 就用 desc，否则按类型兜底
const SUB_FALLBACK = {
  flash: "Flash 怀旧 · 浏览器内模拟运行",
  h5: "H5 · 点开即玩"
};

// 首页三个游戏区块（顺序即页面顺序）
const GROUPS = [
  { key: "mc", title: "我的世界网页版" },
  { key: "flash", title: "Flash 怀旧" },
  { key: "quick", title: "随手就能玩" }
];
const GROUP_KEYS = GROUPS.map((g) => g.key);

const HEAD_SCAN = 8192;       // 只读大包前 8KB 做元信息清理
const BUNDLE_MAX_DELTA = 2048; // 清理后体积变化上限，超出即中止

const cardsPlaceholder = (k) => `<!--@build:cards:${k}-->`;
const countPlaceholder = (k) => `<!--@build:count:${k}-->`;
const METRICS_PLACEHOLDER = "<!--@build:metrics-->";
const UPDATED_PLACEHOLDER = "<!--@build:updated-->";

// ---------------------------------------------------------------- 小工具

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn("WARN ", ...a);

function fail(msg, detail) {
  console.error("ERROR", msg);
  if (detail) console.error(detail);
  process.exitCode = 1;
  throw new Error(msg);
}

/** HTML 文本/属性转义，覆盖 & < > " ' 五个字符 */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtSize(mb) {
  if (mb == null) return "";
  return mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : mb + " MB";
}

function humanBytes(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MiB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KiB";
  return n + " B";
}

/** 按候选路径找源文件：先分层目录（spec §8），再根目录 */
async function resolveSrc(candidates) {
  for (const rel of candidates) {
    try {
      const st = await stat(path.join(ROOT, rel));
      if (st.isFile()) return rel;
    } catch {
      /* 继续找下一个候选 */
    }
  }
  return null;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 流式查找：不把整个文件读进内存 */
async function streamIncludes(file, needle) {
  const rs = createReadStream(file, { highWaterMark: 1 << 20 });
  const target = Buffer.from(needle, "utf8");
  let carry = Buffer.alloc(0);
  try {
    for await (const chunk of rs) {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      if (buf.includes(target)) return true;
      carry = buf.subarray(Math.max(0, buf.length - target.length + 1));
    }
  } finally {
    rs.destroy();
  }
  return false;
}

// ---------------------------------------------------------------- 1. 校验 games.json

function validateGames(raw) {
  const errors = [];
  if (!Array.isArray(raw)) {
    fail("games.json 顶层必须是数组", "实际类型：" + (raw === null ? "null" : typeof raw));
  }
  const seen = new Map();

  raw.forEach((g, i) => {
    if (g == null || typeof g !== "object" || Array.isArray(g)) {
      errors.push(`[${i}] 整项：必须是对象，实际 ${Array.isArray(g) ? "数组" : typeof g}`);
      return;
    }
    // id
    if (typeof g.id !== "string" || !g.id.trim()) {
      errors.push(`[${i}].id：必须是非空字符串，实际 ${JSON.stringify(g.id)}`);
    } else {
      if (seen.has(g.id)) errors.push(`[${i}].id：重复，与 [${seen.get(g.id)}] 冲突`);
      else seen.set(g.id, i);
    }
    // name
    if (typeof g.name !== "string" || !g.name.trim()) {
      errors.push(`[${i}].name：必须是非空字符串，实际 ${JSON.stringify(g.name)}`);
    }
    // type
    if (g.type !== "flash" && g.type !== "h5") {
      errors.push(`[${i}].type：必须是 "flash" 或 "h5"，实际 ${JSON.stringify(g.type)}`);
    }
    // group：决定这张卡进首页哪个区块
    if (!GROUP_KEYS.includes(g.group)) {
      errors.push(
        `[${i}].group：必须是 ${GROUP_KEYS.map((k) => `"${k}"`).join(" / ")}，实际 ${JSON.stringify(g.group)}`
      );
    }
    // desc：卡片第二行，缺省会退成类型兜底（不报错，但会提示）
    if (g.desc !== undefined && (typeof g.desc !== "string" || !g.desc.trim())) {
      errors.push(`[${i}].desc：必须是非空字符串（不填就走类型兜底），实际 ${JSON.stringify(g.desc)}`);
    }
    // size：数字或缺失
    if (g.size !== undefined && g.size !== null) {
      if (typeof g.size !== "number" || !Number.isFinite(g.size)) {
        errors.push(`[${i}].size：必须是数字或缺失，实际 ${JSON.stringify(g.size)}`);
      }
    }
    // icon：缺省用 /default.svg（构建期补，不算错）
    if (g.icon !== undefined && (typeof g.icon !== "string" || !g.icon.trim())) {
      errors.push(`[${i}].icon：必须是非空字符串（缺省会自动补 "/default.svg"），实际 ${JSON.stringify(g.icon)}`);
    }
  });

  if (errors.length) {
    console.error("ERROR games.json 校验失败，共 " + errors.length + " 处：");
    for (const e of errors) console.error("  - " + e);
    console.error("\n不自动修复、不跳过。改好 games.json 再构建。");
    process.exit(1);
  }
  return true;
}

// ---------------------------------------------------------------- 2. 生成卡片

/** 7 张封面都用 default.svg 会一模一样，取名字里的版本号做叠字 */
function tagOf(g) {
  if ((g.icon || "/default.svg") !== "/default.svg") return "";
  const name = String(g.name || "").trim();
  if (/classic/i.test(name)) return "Classic";
  const m = /([\d.]+)\s*$/.exec(name);
  if (!m) return "";
  const tag = m[1].replace(/\.+$/, "");
  return tag.length >= 2 ? tag : "";
}

function cardHtml(g) {
  const type = esc(g.type);
  const name = esc(g.name);
  const icon = esc(g.icon || "/default.svg");
  const [w, h] = IMG_SIZE[g.icon] || IMG_SIZE_FALLBACK;
  const href = g.url || "/game.html?id=" + encodeURIComponent(g.id);
  const sub = esc(g.desc || SUB_FALLBACK[g.type] || "");
  const tag = tagOf(g);
  // 有 cover 字段说明备了 16:10 截图，走 cover--shot；否则按图标处理
  const coverMod = g.cover ? "cover cover--shot" : "cover cover--icon";
  const tagAttr = tag ? ` data-tag="${esc(tag)}"` : "";
  const shotIdx = g.cover ? ` srcset="${esc(g.cover)}"` : "";

  return `<li data-type="${type}" data-id="${esc(g.id)}">
          <a class="card" href="${esc(href)}">
            <span class="${coverMod}"${tagAttr}><img src="${icon}"${shotIdx} alt="" width="${w}" height="${h}" loading="lazy"></span>
            <span class="info">
              <span class="card-title">${name}</span>
              <span class="card-desc">${sub}</span>
              <span class="card-meta">
                <span class="card-size">${esc(fmtSize(g.size))}</span>
                <span class="card-go">开玩 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></span>
              </span>
            </span>
          </a>
          <button class="fav" type="button" data-fav="${esc(g.id)}" aria-pressed="false" aria-label="收藏 ${name}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 16.9l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85z"/></svg>
          </button>
        </li>`;
}

// ---------------------------------------------------------------- 3. 数字条与计数

function metricsHtml(games) {
  const flash = games.filter((g) => g.type === "flash").length;
  const h5 = games.filter((g) => g.type === "h5").length;
  const maxGame = games.reduce((a, b) => ((b.size || 0) > (a.size || 0) ? b : a), games[0]);
  const items = [
    [String(games.length), "款游戏"],
    [String(flash), "款 Flash"],
    [String(h5), "款 H5"],
    [maxGame && maxGame.size != null ? fmtSize(maxGame.size).replace(" ", "") : "—", "最大一款"]
  ];
  return items
    .map(
      ([num, label]) =>
        `            <div class="metric"><span class="metric-num">${esc(num)}</span>` +
        `<span class="metric-label">${label}</span></div>`
    )
    .join("\n");
}

// ---------------------------------------------------------------- 4. 注入 index.html

function buildIndex(template, games, srcRel) {
  let out = template;
  const notes = [];

  for (const grp of GROUPS) {
    const list = games.filter((g) => g.group === grp.key);
    if (!list.length) {
      fail(`分组 "${grp.key}"（${grp.title}）没有任何游戏，首页会空一块`, "改 games.json 的 group 字段");
    }

    const ph = cardsPlaceholder(grp.key);
    if (!out.includes(ph)) {
      fail(
        `${srcRel} 里找不到占位符 ${ph}`,
        `首页区块 "${grp.title}" 的 <ul> 内必须放这个占位符，否则卡片没有落点`
      );
    }
    out = out.replace(ph, list.map(cardHtml).join("\n        "));
    notes.push(`卡片注入：${grp.title} → ${list.length} 张`);

    const cph = countPlaceholder(grp.key);
    if (!out.includes(cph)) {
      fail(`${srcRel} 里找不到计数占位符 ${cph}`);
    }
    out = out.replace(cph, `${list.length} 款`);
  }

  if (!out.includes(METRICS_PLACEHOLDER)) {
    fail(`${srcRel} 里找不到首屏数字条占位符 ${METRICS_PLACEHOLDER}`);
  }
  out = out.replace(METRICS_PLACEHOLDER, metricsHtml(games));
  notes.push("首屏数字条：已按 games.json 计算（含最大一款的体积）");

  const today = new Date().toISOString().slice(0, 10);
  if (out.includes(UPDATED_PLACEHOLDER)) {
    out = out.replace(UPDATED_PLACEHOLDER, today);
    notes.push(`页脚最后更新：${today}`);
  } else {
    warn(`未找到 ${UPDATED_PLACEHOLDER}，页脚"最后更新"留原样`);
  }

  // 注入完还有占位符残留，说明拼错了名字
  const leftover = out.match(/<!--@build:[^>]*-->/g);
  if (leftover) {
    fail(`注入后仍有占位符残留：${[...new Set(leftover)].join(" ")}`);
  }

  return { html: out, notes, counts: { total: games.length } };
}

// ---------------------------------------------------------------- 5a. 大包 <head> 清理

// 要清掉的第三方元信息（只扫前 8KB）
const REMOVE_RES = [
  /[ \t]*<meta\s+name=["']description["'][^>]*>[ \t]*\r?\n?/gi,
  /[ \t]*<meta\s+name=["']keywords["'][^>]*>[ \t]*\r?\n?/gi,
  /[ \t]*<meta\s+(?:property|name)=["']og:locale["'][^>]*>[ \t]*\r?\n?/gi,
  /[ \t]*<meta\s+(?:property|name)=["']og:title["'][^>]*>[ \t]*\r?\n?/gi,
  /[ \t]*<meta\s+(?:property|name)=["']og:description["'][^>]*>[ \t]*\r?\n?/gi,
  /[ \t]*<meta\s+(?:property|name)=["']twitter:[^"']*["'][^>]*>[ \t]*\r?\n?/gi
];

function collectEdits(head, meta) {
  const edits = [];
  for (const re of REMOVE_RES) {
    const r = new RegExp(re.source, "gi");
    let m;
    while ((m = r.exec(head)) !== null) {
      if (m[0].length === 0) r.lastIndex++;
      edits.push({ start: m.index, end: m.index + m[0].length, text: "", why: "remove" });
    }
  }

  const tm = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  if (!tm) throw new Error("前 8KB 内没找到 <title>，拒绝改写");
  const inner = tm[1];
  const innerStart = tm.index + tm[0].length - "</title>".length - inner.length;
  edits.push({ start: innerStart, end: innerStart + inner.length, text: esc(meta.title), why: "title" });

  const afterTitle = tm.index + tm[0].length;
  const block =
    `\n<meta name="description" content="${esc(meta.desc)}">` +
    `\n<meta property="og:title" content="${esc(meta.title)}">` +
    `\n<meta property="og:description" content="${esc(meta.desc)}">`;
  edits.push({ start: afterTitle, end: afterTitle, text: block, why: "insert" });

  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  for (let i = 1; i < edits.length; i++) {
    if (edits[i].start < edits[i - 1].end) throw new Error("元信息编辑区间重叠，拒绝改写");
  }
  return edits;
}

async function copyBundle(srcRel, destAbs, meta) {
  const srcAbs = path.join(ROOT, srcRel);
  const fh = await open(srcAbs, "r");
  let size = 0;
  let headBuf;
  let newHead;
  try {
    const st = await fh.stat();
    size = st.size;
    const scanLen = Math.min(HEAD_SCAN, size);
    headBuf = Buffer.alloc(scanLen);
    await fh.read(headBuf, 0, scanLen, 0);

    // 用 latin1 扫描：1 字符 = 1 字节，切分位置即字节偏移，多字节内容也不会被破坏
    const head = headBuf.toString("latin1");
    if (!/<head\b/i.test(head)) throw new Error("前 8KB 内没找到 <head>，拒绝改写");
    const edits = collectEdits(head, meta);

    const parts = [];
    let pos = 0;
    for (const e of edits) {
      if (e.start < pos) throw new Error("元信息编辑区间重叠，拒绝改写");
      parts.push(headBuf.subarray(pos, e.start));
      if (e.text) parts.push(Buffer.from(e.text, "utf8"));
      pos = e.end;
    }
    parts.push(headBuf.subarray(pos));
    newHead = Buffer.concat(parts);
  } finally {
    await fh.close();
  }

  await mkdir(path.dirname(destAbs), { recursive: true });
  // 流式写：先写改好的头部，再把剩余字节管道过去，绝不整体读入内存
  const ws = createWriteStream(destAbs);
  try {
    await Promise.race([
      once(ws, "open"),
      new Promise((_, rej) => ws.once("error", rej))
    ]);
    if (!ws.write(newHead)) await once(ws, "drain");
    if (newHead.length < size) {
      await pipeline(createReadStream(srcAbs, { start: HEAD_SCAN }), ws, { end: false });
    }
    await new Promise((res, rej) => ws.end((err) => (err ? rej(err) : res())));
  } catch (e) {
    ws.destroy();
    throw e;
  }

  // 体积校验：元信息清理只该动几百字节，差太多说明切坏了
  const outSize = (await stat(destAbs)).size;
  const delta = Math.abs(outSize - size);
  if (delta >= BUNDLE_MAX_DELTA) {
    fail(
      `${srcRel} 清理后体积变化 ${delta} 字节，超过 ${BUNDLE_MAX_DELTA} 上限，判定为异常，已中止`,
      `原 ${humanBytes(size)} → 新 ${humanBytes(outSize)}`
    );
  }

  // 辱骂文案必须彻底消失
  if (await streamIncludes(destAbs, "dumbass")) {
    fail(`${srcRel} 清理后仍含 "dumbass"`);
  }

  return { size, outSize, delta };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const t0 = Date.now();
  log("== games-hub build ==");
  log("root:", ROOT);

  // --- 清掉旧的 dist ---
  if (DIST === ROOT || DIST.length < ROOT.length + 2) fail("dist 路径异常，拒绝清理：" + DIST);
  if (await exists(DIST)) {
    await rm(DIST, { recursive: true, force: true });
    log("已清理旧的 dist/");
  }
  await mkdir(DIST, { recursive: true });

  // --- games.json ---
  const gamesRel = await resolveSrc(["data/games.json", "games.json"]);
  if (!gamesRel) fail("找不到 games.json（试过 data/games.json 与 games.json）");
  const gamesRawText = await readFile(path.join(ROOT, gamesRel), "utf8");
  let gamesRaw;
  try {
    gamesRaw = JSON.parse(gamesRawText);
  } catch (e) {
    fail("games.json 不是合法 JSON：" + e.message);
  }
  validateGames(gamesRaw);
  const games = gamesRaw.map((g) => ({ ...g, icon: g.icon || "/default.svg" }));
  log(`games.json: ${gamesRel} · ${games.length} 项 · 校验通过`);

  // --- index.html ---
  const indexRel = await resolveSrc(["src/index.html", "index.html"]);
  if (!indexRel) fail("找不到 index.html（试过 src/index.html 与 index.html）");
  const template = await readFile(path.join(ROOT, indexRel), "utf8");
  const { html: indexHtml, notes, counts } = buildIndex(template, games, indexRel);
  await writeFile(path.join(DIST, "index.html"), indexHtml, "utf8");
  log(`index.html: ${indexRel} → dist/index.html`);
  for (const n of notes) log("  · " + n);
  log(`  · 分组：${GROUPS.map((g) => `${g.title} ${games.filter((x) => x.group === g.key).length} 款`).join(" / ")}`);

  // --- 其余白名单文件 ---
  const copied = [];
  for (const rel of PAGES) {
    if (rel === "index.html") continue;
    const srcRel = await resolveSrc([path.posix.join("src", rel), rel]);
    if (!srcRel) fail(`白名单页面缺失：${rel}`);
    const destAbs = path.join(DIST, rel);
    await mkdir(path.dirname(destAbs), { recursive: true });
    await copyFile(path.join(ROOT, srcRel), destAbs);
    copied.push({ rel, src: srcRel, size: (await stat(destAbs)).size, cleaned: false });
  }
  for (const rel of EXTRA) {
    const srcRel = await resolveSrc([path.posix.join("src", rel), rel]);
    if (!srcRel) fail(`白名单文件缺失：${rel}`);
    const destAbs = path.join(DIST, rel);
    await mkdir(path.dirname(destAbs), { recursive: true });
    await copyFile(path.join(ROOT, srcRel), destAbs);
    copied.push({ rel, src: srcRel, size: (await stat(destAbs)).size, cleaned: false });
  }

  // --- 4 个大包：覆盖上面的原样拷贝，做 <head> 清理 ---
  for (const rel of Object.keys(BUNDLE_META)) {
    const srcRel = await resolveSrc([path.posix.join("bundles", rel), rel]);
    if (!srcRel) fail(`大包缺失：${rel}`);
    const destAbs = path.join(DIST, rel);
    const r = await copyBundle(srcRel, destAbs, BUNDLE_META[rel]);
    const idx = copied.findIndex((c) => c.rel === rel);
    if (idx >= 0) copied.splice(idx, 1);
    copied.push({ rel, src: srcRel, size: r.outSize, cleaned: true, delta: r.delta });
  }

  // --- 汇总 ---
  copied.sort((a, b) => a.rel.localeCompare(b.rel));
  log("\n-- 产物 --");
  let total = 0;
  for (const c of copied) {
    total += c.size;
    log(
      `  ${c.cleaned ? "clean" : "copy "}  ${c.rel.padEnd(24)} ${humanBytes(c.size).padStart(11)}` +
        (c.cleaned ? `  (Δ ${c.delta}B)` : "")
    );
  }
  const indexSize = (await stat(path.join(DIST, "index.html"))).size;
  total += indexSize;
  log(`  inject index.html${" ".repeat(12)} ${humanBytes(indexSize).padStart(11)}`);

  log(`\n-- 汇总 --`);
  log(`  文件数：${copied.length + 1}`);
  log(`  总大小：${humanBytes(total)}`);
  log(`  已排除：${EXCLUDED.join("  ")}（白名单之外的一切都不进 dist/）`);
  log(`  耗时：${((Date.now() - t0) / 1000).toFixed(2)}s`);
  log("\nOK");
}

main().catch((e) => {
  if (!process.exitCode) console.error(e && e.stack ? e.stack : e);
  process.exit(process.exitCode || 1);
});
