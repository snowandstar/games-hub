#!/usr/bin/env node
/**
 * scripts/build.mjs — games-hub 构建脚本（零依赖，Node >= 18）
 *
 * 用法：node scripts/build.mjs
 * 产出：dist/（Pages 的 Output directory）
 *
 * 只做五件事，不做别的：
 *   1. 校验 games.json（不合法就非零退出，不自动修复）
 *   2. 生成首页卡片，注入 index.html 的 <!--@build:game-cards-->
 *   3. 注入 <script type="application/json" id="gamesData">，客户端不再 fetch('/api/games')
 *   4. 构建期算好计数条（共 N 款 / Flash N / H5 N）写进 HTML
 *   5. 白名单拷贝到 dist/；4 个大包只改 <head> 元信息，流式处理
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
const EXTRA = ["_worker.js", "robots.txt", "default.svg", "bh32.jpg", "bh33.jpg", "games.json"];

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
  "/default.svg": [400, 300],
  "/bh32.jpg": [72, 72],
  "/bh33.jpg": [72, 72]
};
const IMG_SIZE_FALLBACK = [400, 300];

// 副文案缺省值：games.json 里有 desc 就用 desc，否则按类型兜底
const SUB_FALLBACK = {
  flash: "Flash 怀旧 · 浏览器内模拟运行",
  h5: "H5 · 点开即玩"
};

const HEAD_SCAN = 8192;       // 只读大包前 8KB 做元信息清理
const BUNDLE_MAX_DELTA = 2048; // 清理后体积变化上限，超出即中止

const CARDS_PLACEHOLDER = "<!--@build:game-cards-->";
const COUNTS_PLACEHOLDER = "<!--@build:counts-->";

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

function cardHtml(g) {
  const type = esc(g.type);
  const name = esc(g.name);
  const icon = esc(g.icon || "/default.svg");
  const [w, h] = IMG_SIZE[g.icon] || IMG_SIZE_FALLBACK;
  const href = g.url || "/game.html?id=" + encodeURIComponent(g.id);
  const sub = esc(g.desc || SUB_FALLBACK[g.type] || "");

  return `<li data-type="${type}">
        <a class="card ${type}" href="${esc(href)}">
          <div class="cover"><img src="${icon}" alt="${name}" loading="lazy" width="${w}" height="${h}"></div>
          <div class="info">
            <h3>${name}</h3>
            <p class="sub">${sub}</p>
            <div class="meta">
              <span class="size">${esc(fmtSize(g.size))}</span>
              <span class="play">开始游戏 →</span>
            </div>
          </div>
        </a>
      </li>`;
}

// ---------------------------------------------------------------- 3/4. 注入 index.html

function buildIndex(template, games, srcRel) {
  const cards = games.map(cardHtml).join("\n      ");
  const flash = games.filter((g) => g.type === "flash").length;
  const h5 = games.filter((g) => g.type === "h5").length;
  const countsHtml =
    `<span class="pill">共 <b>${games.length}</b> 款</span>\n` +
    `          <span class="pill">Flash <b>${flash}</b></span>\n` +
    `          <span class="pill">H5 <b>${h5}</b></span>`;

  let out = template;
  const notes = [];

  // --- 卡片 ---
  if (out.includes(CARDS_PLACEHOLDER)) {
    out = out.replace(CARDS_PLACEHOLDER, cards);
    notes.push(`卡片注入：命中占位符 ${CARDS_PLACEHOLDER}`);
  } else {
    // 源里还没有占位符：退回到 #grid 空容器，并把它升级成 <ul>（<li> 不能直接放 <div>）
    const re = /<div([^>]*\bid=["']grid["'][^>]*)>\s*<\/div>/i;
    const m = re.exec(out);
    if (!m) {
      fail(
        `${srcRel} 里既没有 ${CARDS_PLACEHOLDER} 也没找到空的 <div id="grid">，` +
          "无法注入卡片。请在 #grid 内放入占位符，或保留空的 #grid 容器。"
      );
    }
    out = out.replace(re, `<ul$1>\n      ${cards}\n    </ul>`);
    notes.push(`卡片注入：未找到占位符，已降级为替换空的 <div id="grid">（并升级为 <ul>）。` +
      `建议后续在 ${srcRel} 的 #grid 内加上 ${CARDS_PLACEHOLDER}`);
  }

  // --- 计数条 ---
  if (out.includes(COUNTS_PLACEHOLDER)) {
    out = out.replace(COUNTS_PLACEHOLDER, countsHtml);
    notes.push(`计数条注入：命中占位符 ${COUNTS_PLACEHOLDER}`);
  } else {
    const re = /<div([^>]*\bid=["']counts["'][^>]*)>\s*<\/div>/i;
    if (re.test(out)) {
      out = out.replace(re, `<div$1>${countsHtml}</div>`);
      notes.push("计数条注入：未找到占位符，已降级为填充空的 #counts");
    } else {
      warn("未找到计数条容器 #counts，跳过计数注入（卡片数与计数可能不一致）");
    }
  }

  // --- 副文案样式（源 CSS 里没有 .sub，构建期补一条，不动源码）---
  if (out.includes("</style>")) {
    out = out.replace(
      "</style>",
      "\n.info .sub { color: var(--sub); font-size: 12.5px; line-height: 1.5; margin: 0 0 6px; }\n</style>"
    );
  }

  // --- 关掉 fetch('/api/games')：卡片与数据已内联，不再需要骨架屏那一轮 ---
  const json = JSON.stringify(games).replace(/</g, "\\u003c");
  const loadRe = /^[ \t]*load\(\);[ \t]*$/m;
  if (loadRe.test(out)) {
    out = out.replace(loadRe, "// load() 由构建期移除：卡片与 #gamesData 已内联，不再 fetch('/api/games')");
    notes.push("运行时：已移除 load() 调用，改为同步读 #gamesData");
  } else {
    warn("未找到独立的 load(); 调用，页面仍会 fetch('/api/games')（骨架屏会闪一下）");
  }

  // 源码里的运行时模板仍带 role="listitem"，且 render() 会用 innerHTML 把构建好的 <li> 冲掉。
  // 两处都在产物里改（源码不动）：去掉 listitem 角色，并把 render() 换成显隐过滤。
  const listItemRe = / href="\$\{href\}" role="listitem">/;
  if (listItemRe.test(out)) {
    out = out.replace(listItemRe, ' href="${href}">');
    notes.push('运行时：<a> 上的 role="listitem" 已移除（卡片语义交给 <ul>/<li>）');
  } else {
    warn('未找到 href="${href}" role="listitem">，无法移除 <a> 上的 role="listitem"');
  }

  const inject =
    `<script type="application/json" id="gamesData">${json}</script>\n` +
    `<script>\n` +
    `// 构建期注入：卡片与数据已在 HTML 里，不发请求、不出骨架屏\n` +
    `(function () {\n` +
    `  var el = document.getElementById("gamesData");\n` +
    `  var d = [];\n` +
    `  try { d = JSON.parse(el.textContent || "[]"); } catch (e) { d = []; }\n` +
    `  GAMES = Array.isArray(d) ? d : [];\n` +
    `  // 覆盖 render()：卡片不再重绘，只按类型显隐，避免 innerHTML 冲掉构建好的 <li>\n` +
    `  render = function () {\n` +
    `    var items = document.querySelectorAll("#grid > li"), shown = 0, i, ok;\n` +
    `    for (i = 0; i < items.length; i++) {\n` +
    `      ok = (curFilter === "all" || items[i].getAttribute("data-type") === curFilter);\n` +
    `      items[i].style.display = ok ? "" : "none";\n` +
    `      if (ok) shown++;\n` +
    `    }\n` +
    `    var st = document.getElementById("state");\n` +
    `    if (st) {\n` +
    `      if (shown) { st.style.display = "none"; }\n` +
    `      else {\n` +
    `        st.style.display = "block";\n` +
    `        if (!st.innerHTML) st.textContent = "暂无该类型的游戏";\n` +
    `      }\n` +
    `    }\n` +
    `  };\n` +
    `  render();\n` +
    `})();\n` +
    `</script>\n`;

  const bodyIdx = out.lastIndexOf("</body>");
  if (bodyIdx === -1) fail(`${srcRel} 里找不到 </body>，无法注入 #gamesData`);
  out = out.slice(0, bodyIdx) + inject + out.slice(bodyIdx);

  return { html: out, notes, counts: { total: games.length, flash, h5 } };
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
  log(`  · 计数条：共 ${counts.total} 款 / Flash ${counts.flash} / H5 ${counts.h5}`);

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
