# games-hub 站点规格卡（v3 · 门禁保持，治理技术债）

> 版本：v3.0 · 2026-10-17 · 作者：文构间（信息架构）
> 状态：可施工。前端、后端、部署三方照此文件落代码，**字段与路径不得各自定义**。
> v3 变更：门禁策略由 B 改为 **C（保持登录门禁）**，SEO 类目标整体撤出，相关条目转为「防收录修复」；P0 重排为「删运行时补丁 / 数据单源 / 真 404 与 robots / 登录态性能 / 首页首屏 / 安全四件」。
> 线上实测（2026-10-17）：`/` → 302 `/login.html`；`/robots.txt` → 200 + `text/html` 28989 字节（首页内容）；`/definitely-not-a-page-xyz` → 200 + 首页内容；`/login.html` → 308 `/login`。

---

## 0. 本轮范围与结论

| 项 | 结论 |
|---|---|
| 站点类型 | 工具站（游戏合集 + 轻量工具），**登录后可见的私域站点** |
| 核心转化动作 | **开始游戏**（登录之后的一切摩擦都要为它让路） |
| 门禁 | **C：保持登录门禁**，站点不对外索引 |
| 本轮主线 | 不是 SEO，而是**修真实缺陷**：坏掉的功能、慢的首屏、会丢的数据、能被抢的管理员、会被刷爆的 Key |
| 托管 | 继续 Cloudflare Pages（advanced mode 单文件 Worker），不迁平台 |
| 数据源 | `games.json` 为唯一真相，Worker 运行时读取 + 内存缓存 |
| 新引入 | 一个零依赖构建脚本（源目录 `src/` → 发布目录 `dist/`，注入首页卡片块 + 校验数据） |

### 0.1 为什么本轮不做 SEO（一段话，不再展开）

站点是登录后才有内容的私域站点，未登录的访客和爬虫看到的都只有登录页；而允许匿名访问，会让游戏版权内容、65MB 的 SWF 转发、AI 代理额度直接暴露在公网上——这三样都不是加个 meta 标签能兜住的。所以本轮的取舍是：**先把「登录门禁」这个产品决策执行干净，把所有 SEO 动作（sitemap、结构化数据、关键词导向的 TDK、页面级预渲染）整体推迟到「决定公开」那一天**。在那之前技术侧只做一件事——**确保不该被收录的东西一定不会被收录**（robots 全禁 + `noindex` 兜底），这是 bug 修复，不是 SEO 优化，成本不到 1 小时。

**代价写在明处**：只要门禁在，搜索引擎永远只会看到一个登录页，站点不可能靠搜索获客；每个被分享出去的链接，新访客第一眼都是登录框。这是产品选择，不是缺陷——哪天希望被搜到，第 9 节的 P2 就是重新开工的清单。

---

## 1. 站点定位与目标访客

### 1.1 一句话定位

**「登录就能玩、免安装的网页游戏合集——《我的世界》4 个版本 +《死神VS火影》Flash 怀旧 2 个版本 + 2048 / 扫雷 / 贪吃蛇，外带工具箱、影视音乐收藏与留言板。」**

### 1.2 目标访客

| 访客 | 场景 | 他要什么 | 关键页面 |
|---|---|---|---|
| 站长本人（1 人） | 加游戏、配 AI 预设、删垃圾留言 | 改一个文件就能加游戏；后台别被抢 | `/account`、`/ai-admin` |
| 被邀请的熟人（个位数到几十人） | 收到链接，第一次来 | **别让我填一堆东西**；登录后立刻看到游戏 | `/login` → `/` |
| 回访的老用户 | 直接打开站点 | 别再让我登录一次；首屏别空白 | `/` |

**不服务的访客**：搜索引擎来的陌生人（门禁会挡住，这是设计意图）、想找联机对战或游戏下载的人。

### 1.3 核心转化动作（排优先级）

| 序 | 动作 | 判定 | 说明 |
|---|---|---|---|
| **1（核心）** | **进入游戏并开始玩** | 卡片点击 → 游戏画面出现 | 站点唯一不可替代的价值 |
| 2 | 完成登录 | `/api/auth/login` 成功且回到原页面 | 唯一前置门槛，必须一次过 |
| 3 | 留言 | POST `/api/msg` 成功 | 留存信号，最小化实现 |

### 1.4 转化路径与摩擦点（现状 → 目标）

**路径 A：登录后玩游戏（核心）**

```
现状：打开 / → 302 /login.html → 再 308 /login（两次跳转）→ 登录 → 跳回首页而不是你原本要去的页面 → 骨架屏 → 等 /api/games → 卡片 → 点《我的世界》→ 直接拉 14~20MB 单文件 → 白屏数秒
摩擦点：① 双跳（302 + 308）② 登录后丢失原目标（无 next）③ 首屏等接口 + 骨架屏闪一下 ④ 大包加载无任何提示
```

```
目标：/ → 302 /login?next=%2F（一次跳转）→ 登录成功直接回 next → 首屏 HTML 已含 9 张卡片（0 次接口往返、无骨架屏）→ 点击游戏 → 对应游戏页
削减动作：合并双跳；加 next 回跳；卡片构建期注入；骨架屏代码删除
```

**路径 B：留言**

```
现状：登录 → 留言板 → 提交（并发写单键，两人同时发必丢一条）
目标：读不需要额外动作；写失败有明确提示；并发写入不丢
```

**路径 C：加一款游戏（站长）**

```
现状：改 _worker.js 内嵌数组 + 改 games.json + 传 Release + 记资产 ID + 手工同步两处（已实际漂移：swf 一边 "bh32.swf"、一边 "/swf/bh32.swf"）
目标：只改 games.json 一条 → 跑 build → 上传
```

---

## 2. 站点地图与页面清单

### 2.1 站点地图（URL 全部保持现状，不重构）

**结论：不做 URL 重构。** 门禁保持的前提下，URL 改造换不到任何收益（不会被索引、不需要关键词），而移动 25MB 文件 + 改路由 + 改前端链接是纯风险。只新增 `/404.html` 与 `/robots.txt`。

```
/
├── /                    首页（登录后）= 游戏列表
├── /tools               工具箱（二维码 / Markdown / 图片 / 文本等面板）
├── /media               影视音乐（LocalStorage 私人收藏夹）
├── /guestbook           留言板
├── /game2048            2048（自包含）
├── /snake               贪吃蛇（自包含）
├── /minesweeper         扫雷（自包含）
├── /game?id=<id>        Flash 播放页（`/game.html` 会被 308 到 `/game`，站内统一用 `/game?id=`）
├── /minecraft           我的世界 1.8.8（单文件大包 14.4MB）
├── /minecraft-1122      我的世界 1.12.2（19.2MB）
├── /minecraft-125       我的世界 1.2.5（6.0MB）
├── /minecraft-classic   我的世界 Classic（3.6MB）
├── /login               登录/注册
├── /account             账号设置（需登录）
├── /ai-admin            AI 预设管理（需管理员）
├── /404.html            真 404 页（新增，公开）
├── /robots.txt          全站禁收录（新增，公开）
└── /api/*               接口（公开，自带鉴权）
```

**页面取舍（有结论，不左右摇摆）**

| 候选 | 决定 | 理由 |
|---|---|---|
| `/play/<slug>` 游戏包装页 | **本轮不做** | 它的价值一半是「让爬虫读到文字」（门禁在，为零），一半是「大包不进首屏」（可用加载提示以更低成本解决，P2-1） |
| `/games` 独立列表页 | **不做** | 与首页 100% 重复 |
| `/about`、`/news` | **不做** | 无内容可写，上线即空页 |
| `/sitemap.xml` | **不做**（保持 404） | 全站 `Disallow: /` 时提交 sitemap 自相矛盾 |

### 2.2 页面清单

**全站统一：不索引。** 三层手段（见 6.3）：`robots.txt` 全禁 → HTML 响应 `X-Robots-Tag: noindex, nofollow` → 每页 `<meta name="robots" content="noindex, nofollow">`。

| # | 页面 | 路径 | 用途 | 关键区块 | 需后端数据 | 是否需登录 | 当前状态 |
|---|---|---|---|---|---|---|---|
| 1 | 首页 | `/` | 登录后 1 秒内看到「有什么、点哪个」 | 侧边导航 / H1+计数 / 类型筛选 / 9 张卡片 | **否（构建期注入）** | 是 | 需改：骨架屏 + 一次 fetch |
| 2 | 工具箱 | `/tools` | 打开即用的 6 个小工具 | 面板 tabs / 表单与输出 | 否 | 是 | 需改：导航副本、标题层级 |
| 3 | 影视音乐 | `/media` | 私人收藏（LocalStorage） | 分类 tabs / 添加 / 网格 | 否 | 是 | 可用 |
| 4 | 留言板 | `/guestbook` | 留言 + 社区感 | 表单 / 列表 / 管理员删除 | GET/POST/DELETE `/api/msg` | 是（删除需管理员） | 需改：并发丢数据 |
| 5 | 2048 | `/game2048` | 打开即玩 | H1 + 棋盘 | 否 | 是 | 可用 |
| 6 | 贪吃蛇 | `/snake` | 打开即玩 | H1 + canvas | 否 | 是 | 需改：无触屏 |
| 7 | 扫雷 | `/minesweeper` | 打开即玩 | H1 + 难度 + 棋盘 | 否 | 是 | 需改：无触屏（只能右键） |
| 8 | Flash 播放页 | `/game?id=<id>` | 跑 SWF（Ruffle） | 标题 / 全屏 / 加载提示 / 播放器 | GET `/api/games`、`/api/swf` | 是 | **需修：Worker 补丁误删 appendChild，Flash 黑屏** |
| 9–12 | 我的世界 ×4 | `/minecraft`… | 单文件大包直接运行 | 全屏 canvas | 否 | 是 | 需改：head 里第三方英文 og（含辱骂文案） |
| 13 | 登录/注册 | `/login` | 唯一入口 | 品牌 / 切换 / 2 字段 / 错误提示 | auth API | 否 | 需改：无 `next` 回跳、a11y |
| 14 | 账号设置 | `/account` | 头像/用户名/密码/管理员入口 | 头像网格 / 改名 / 改密 / 退出 | auth API | 是 | 需改：无导航 |
| 15 | AI 预设管理 | `/ai-admin` | 站长配置预设模型 | 表单 / 列表 / 编辑删除 | ai presets API | 是 + 管理员 | 需改：无导航 |
| 16 | 404 | `/404.html` | 真 404（新增） | 一句话 + 回首页 + 3 个游戏入口 | 否 | 否 | **新建** |

---

## 3. 门禁策略：C（保持），以及它的技术后果

**决定**：保留 `_worker.js` 的登录门禁，站点不对外。

**既然保留，就必须把它做对。** 现有实现有四个技术问题，与「要不要公开」无关，纯属实现缺陷：

| 现状问题 | 后果 | 归属 |
|---|---|---|
| 未登录 → `302 /login.html`，而 `/login.html` 又被 Pages 308 到 `/login` | 每次冷启动多一次往返；分享链接首屏更慢 | P0（6.4） |
| 跳登录页不带 `next`，登录后一律回首页 | 用户点进 `/guestbook` 被踢去登录，登录完掉到首页，得再找一次 | P0（6.4） |
| 门禁判定为 `Cookie → KV.get('sess:...')`，**每个页面请求一次 KV 读** | 首屏被 KV 拖慢；KV 读额度被消耗在页面路径上 | P0（6.4） |
| 门禁与「HTML 改写」串在同一个 `fetch` 里，改写要 `await resp.text()` 读完整个响应体 | **首字节被推迟到整个 HTML 缓冲完**，这是 1.2–1.7s 的直接嫌疑 | P0（6.1） |

**门禁保持带来的附加要求（都是小改动，别漏）**

1. 门禁白名单里**必须放行** `/robots.txt`、`/404.html`、`/login`、`/api/*`，否则「防收录」与「真 404」两项修复会被门禁自己挡掉。
2. `game2048|minesweeper|snake|minecraft|account|ai-admin` 用正则前缀匹配可以保留，但**必须显式排除** `/api/`（现在靠判断顺序侥幸生效，改代码时容易踩）。
3. 302 目标统一写 `/login?next=<encodeURIComponent(原 path+search)>`，不要再出现 `.html`。

---

## 4. 接口契约（冻结，前后端唯一依据）

### 4.0 统一约定

- 内容类型：JSON（`/api/swf` 为二进制）。
- **成功体**：至少含 `ok:true`（`GET /api/games`、`GET /api/msg` 是纯数组/列表，见下）。
- **错误体**：`{ "error": "给用户看的中文一句话", "code": "machine_readable_code" }`。**`code` 为本次新增字段**，前端按 `code` 分支、按 `error` 展示；后端一律返回 `code`。
- 鉴权：`Authorization: Bearer <token>`（token 在 localStorage `ghub_token`）。**页面门禁**另用 `ghub_gate` cookie（HMAC 签名，见 6.4），API 不认它。
- 响应头：API 一律 `Cache-Control: no-store`（`/api/games` 例外）。
- 时间字段：number（毫秒时间戳）。
- **`/api/ai/presets` 的返回体永不含 `key`**（现状已正确，列为回归测试项，任何人不得改）。

### 4.1 契约表

| # | 方法 | 路径 | 入参（字段:类型:必填） | 出参 | 鉴权 | 错误码 | 变化 |
|---|---|---|---|---|---|---|---|
| 1 | GET | `/api/games` | 无 | `[{ id:string, name:string, type:"h5"\|"flash", size?:number(MB), icon:string, url?:string, swf?:string }]` | 无 | 500 `data_unavailable` | **变**：数据源改读 `games.json`（内存缓存 + 预序列化 + `Cache-Control: public, max-age=60`），不再内嵌数组 |
| 2 | GET | `/api/swf?id=<gameId>` | `id:string:必填` | `application/x-shockwave-flash` 二进制 | **登录态**（页面门禁已覆盖，API 层不再单独加 Referer/限流） | 404 `game_not_found` / 404 `asset_not_found` / 500 `gh_token_missing` / 502 `upstream_error` / 405 `method_not_allowed` | 不变（原计划的 Referer 校验与 IP 限流**撤销**，见 6.2 末尾） |
| 3 | POST | `/api/auth/register` | `username:string:必填`(2–20 位 `[\w\u4e00-\u9fa5]`)、`password:string:必填`(6–64)、`setup_code?:string` | `{ ok:true, admin:boolean }` | 无 | 400 `invalid_username` / 400 `invalid_password` / 409 `username_taken` / 429 `too_many_attempts` | **变**：首个注册者不再自动 admin，须 `setup_code`（6.6） |
| 4 | POST | `/api/auth/login` | `username:string:必填`、`password:string:必填` | `{ ok:true, token:string, username:string, admin:boolean, avatar:string }` + `Set-Cookie: ghub_gate`、`ghub_token` | 无 | 401 `bad_credentials` / 429 `too_many_attempts` | **变**：下发 HMAC 门禁 cookie；Cookie 加 `HttpOnly; Secure`；补 `avatar` |
| 5 | GET | `/api/auth/me` | 无 | `{ ok:true, username:string, admin:boolean, avatar:string }` | Bearer | 401 `unauthorized` | 不变 |
| 6 | POST | `/api/auth/logout` | 无 | `{ ok:true }` + 清两个 Cookie | Bearer 或 Cookie | — | **变**：同时清 `ghub_gate` 与 `ghub_token`、删 KV 会话 |
| 7 | POST | `/api/auth/change-username` | `new_username:string:必填` | `{ ok:true, token:string, username:string, admin:boolean, avatar:string }` | Bearer | 400 `invalid_username` / 401 `unauthorized` / 404 `user_not_found` / 409 `username_taken` | **变**：不再遍历改写历史留言的名字（留言存快照）；同时刷新 `ghub_gate` |
| 8 | POST | `/api/auth/change-password` | `old_password:string:必填`、`new_password:string:必填`(6–64) | `{ ok:true }` | Bearer | 400 `invalid_password` / 401 `old_password_wrong` / 404 `user_not_found` | 不变 |
| 9 | POST | `/api/auth/update-avatar` | `avatar:string:必填`（16 个预设 emoji 之一） | `{ ok:true, avatar:string }` | Bearer | 400 `invalid_avatar` / 401 `unauthorized` / 404 `user_not_found` | 不变 |
| 10 | POST | `/api/auth/refresh-cookie` | 无 | `{ ok:true }` + `Set-Cookie: ghub_gate` | Bearer | 401 `unauthorized` | **新增（P1）**：localStorage 有 token 但门禁 cookie 丢失/过期时补票，避免重复登录 |
| 11 | GET | `/api/msg?limit=<n>` | `limit:number:选填`（默认 50，上限 50） | `[{ id:string, name:string, avatar:string, text:string, time:number }]` | 无 | — | **变**：一留言一键 + `KV.list` 并行取 + 15s 边缘缓存 |
| 12 | POST | `/api/msg` | `text:string:必填`（≤500 字，去空白后非空） | `{ ok:true, id:string }` | Bearer | 400 `empty_text` / 401 `unauthorized` / 429 `msg_rate_limited`（**本轮新增**阈值：同一用户 10 分钟内最多 5 条，第 6 条起拒；现状没有任何留言限流） / 500 `write_failed` | **变**：单键单写，出参去掉 `count` |
| 13 | DELETE | `/api/msg?id=<msgId>` | `id:string:必填` | `{ ok:true }` | Bearer + 管理员 | 400 `missing_id` / 401 `unauthorized` / 403 `admin_required` / 404 `msg_not_found` | **变**：单键 `delete` |
| 14 | GET | `/api/ai/presets` | 无 | `{ ok:true, presets:[{ id:string, name:string, baseURL:string, model:string, desc:string }] }`（**永不含 key**） | Bearer | 401 `unauthorized` | 不变（**安全回归项**） |
| 15 | POST | `/api/ai/presets` | `name:string:必填`、`baseURL:string:必填`(https)、`model:string:必填`、`key:string:必填`、`desc?:string`(≤120) | `{ ok:true, id:string }` | Bearer + 管理员 | 400 `invalid_preset` / 401 / 403 `admin_required` | 不变 |
| 16 | PUT | `/api/ai/presets` | `id:string:必填`、`name?`、`baseURL?`、`model?`、`key?`（空串=不改）、`desc?` | `{ ok:true }` | Bearer + 管理员 | 400 `invalid_preset` / 403 / 404 `preset_not_found` | 不变 |
| 17 | DELETE | `/api/ai/presets?id=<presetId>` | `id:string:必填` | `{ ok:true }` | Bearer + 管理员 | 400 `missing_id` / 403 / 404 `preset_not_found` | 不变 |
| 18 | POST | `/api/ai/chat` | `messages:{role,content}[]:必填`（末 10 条、总字符 ≤8000）；`preset_id?:string`；无预设时 `baseURL:string:必填`、`model:string:必填`、`key:string:必填`；`temperature?:number`(0–2，默认 0.7)；`max_tokens?:number`(200–2000，默认 800) | `{ ok:true, content:string }` | Bearer | 400 `messages_required` / 400 `params_required` / 400 `invalid_base_url`(P1) / 401 `unauthorized` / 404 `preset_not_found` / **429 `user_rate_limited`（必带 `window`+`resetAt`）** / **429 `ip_rate_limited`（必带 `window`+`resetAt`）** / **429 `global_quota_exceeded`（必带 `resetAt`）** / 502 `upstream_error` / 500 `proxy_failed` | **变**：三级限流、请求体上限、`max_tokens` 默认 800；**预设仍对所有登录用户可见可用** |
| 19 | OPTIONS | `/api/ai/*` | 无 | 204 + CORS 头 | 无 | — | 不变（允许源仍限 `https://4m8dv3g0c7b16.doubao.link`） |

**契约红线**：以上 19 条冻结。前端不得新增字段、不得省略 `code` 分支；后端不得改字段名与错误码字符串。**第 14 条「不含 key」是安全回归项**，改动前先跑这条。

#### 4.1.1 429 响应体（`/api/ai/chat` 三个限流码）

在上文 `{ error, code }` 的基础上**追加两个必填字段**，前端据此选择措辞与倒计时：

```json
{ "error": "这一小时聊得有点多，歇一会儿再来", "code": "user_rate_limited", "window": "hour", "resetAt": 1792280400000 }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `error` | string | 是 | 直接展示给用户的中文一句话 |
| `code` | string | 是 | `user_rate_limited` / `ip_rate_limited` / `global_quota_exceeded` |
| `window` | `"hour"` \| `"day"` | 是（仅前两个码） | 标明命中的是哪一档，决定前端措辞。`global_quota_exceeded` **不返回** `window`（它只有日档语义） |
| `resetAt` | number（epoch 毫秒） | 是（三个码都要） | 额度恢复时刻。前端用 `Math.max(0, resetAt - Date.now())` 换算成「X 分钟／X 小时后可再用」，**不要返回相对秒数**（网络延迟会让它不准） |

**取值规则**

- 小时键命中 → `window:"hour"`，`resetAt` = 下一个整点。
- 日键命中 → `window:"day"`，`resetAt` = 次日 00:00。
- **小时档与日档同时命中时，一律回日档**（`window:"day"`）——用户更需要知道「今天没得用了」，而不是「再等 20 分钟又被挡一次」。
- `ip_rate_limited` 的 `window` 恒为 `"hour"`，`resetAt` = 下一个整点。
- `global_quota_exceeded` 的 `resetAt` = 次日 00:00。
- **时区固定按 UTC+8 计算日界**：Worker 跑在 UTC，若直接取 UTC 零点，用户会在「凌晨 4 点恢复」这种时刻看到额度回来。日键的 key 后缀（`YYYYMMDD`）与 `resetAt` 必须用同一套 UTC+8 计算，否则会出现「键还没过期但 resetAt 已过」的矛盾。

---

### 4.2 KV 键约定

| 键 | 值 | TTL | 状态 |
|---|---|---|---|
| `user:<username>` | `{ salt, hash, admin, avatar, created }` | 无 | 不变 |
| `sess:<token>` | `{ username, exp }` | 30 天 | 不变（API 鉴权用） |
| `fail:<ip>` | 数字字符串 | 900s | 不变 |
| `msg:<id>` | `{ id, name, avatar, text, time }` | 365 天 | **新**（`msgs` 废弃，见 6.7） |
| `aiq:u:<username>:<YYYYMMDD>` | 数字字符串 | 86400s | **新**：用户日计数 |
| `aiq:uh:<username>:<YYYYMMDDHH>` | 数字字符串 | 3600s | **新**：用户小时计数 |
| `aiq:ip:<ip>:<YYYYMMDDHH>` | 数字字符串 | 3600s | **新**：IP 小时计数 |
| `aiq:all:<YYYYMMDD>` | 数字字符串 | 86400s | **新**：全站日熔断 |
| `ai_presets` | 预设数组（含 key） | 无 | 不变 |

**KV 免费额度约束（必须知道）**：写 1000 次/天、读 10 万次/天。AI 限流每请求最多 4 读 + 4 写，即**一天内 AI 调用 250 次就打满写配额**。所以 6.5 的阈值由配额倒推，且站长要在 Cloudflare 后台盯 KV writes。

---

## 5. 功能清单与验收标准

| # | 功能 | 所属 | 优先级 | 验收标准（可测） |
|---|---|---|---|---|
| F1 | 删除运行时 HTML/JS 字符串 replace，逻辑下沉源码 | `_worker.js`、`game.html` | **P0** | `_worker.js` 不再对 HTML 做 `.replace(`；`/game?id=bleshui-vs-huoYing-3.2` 能真正播放（Ruffle 画布出现，不是空白黑框） |
| F2 | 游戏数据单源化 | `_worker.js`、`games.json` | **P0** | 只改 `games.json` 加一条，`/api/games` 与首页卡片同时生效；`_worker.js` 里搜不到游戏数组字面量 |
| F3 | 真 404 | 全站 | **P0** | `/definitely-not-here` 返回 **404** 且 body 是 404 页；`/sitemap.xml` 返回 404 |
| F4 | robots.txt 全禁且类型正确 | 全站 | **P0** | `curl -i /robots.txt` → 200 + `text/plain`，内容为 `User-agent: *` / `Disallow: /` |
| F5 | 登录态校验性能 | 门禁 | **P0** | 带有效 cookie 的首页 TTFB ≤ 400ms（改造前 1.2–1.7s）；页面请求路径 **0 次 KV 读** |
| F6 | 登录后回跳原页面 | `/login` | **P0** | 未登录访问 `/guestbook` → `/login?next=%2Fguestbook` → 登录后落在 `/guestbook`；`next` 仅接受同源相对路径（防开放重定向） |
| F7 | 首页首屏静态渲染 | `/` | **P0** | 带 cookie `curl / \| grep -c 'class="card'` ≥ 9；禁用 JS 仍能看到 9 款游戏名与链接；首屏无骨架屏、无 `/api/games` 请求 |
| F8 | 管理员抢注修复 | 注册 | **P0** | 空 KV 且 `ADMIN_SETUP_CODE` 已配置：不带 `setup_code` → `admin:false`；带正确 code → `admin:true`；带错误 code → 400 |
| F9 | 留言并发不丢 | `/guestbook` | **P0** | 10 个并发 POST 后 GET 能看到 10 条（改造前会丢） |
| F10 | Cookie 加固 | 登录/登出 | **P0** | `Set-Cookie` 含 `HttpOnly; Secure; SameSite=Lax` |
| F11 | CSP（折中版，不白屏） | 全站 | **P0** | 先 `Report-Only` 跑 24h 无违规再切正式；切正式后 Flash 页、AI iframe、工具箱、4 个大包逐个人工验 |
| F12 | AI 限流 | `/api/ai/chat` | **P0** | 单用户超 30 次/小时 → 429 `user_rate_limited`；换号超 IP 阈值 → 429 `ip_rate_limited`；`max_tokens` 默认 800。**超限响应必须同时含 `code`、`window`、`resetAt` 三字段**：`resetAt` 为 epoch 毫秒（非相对秒数），`window` ∈ {`hour`,`day`}，`global_quota_exceeded` **不含** `window`；小时档与日档同时命中时 `window` 必须为 `day` |
| F13 | AI 预设 Key 不下发 | `/api/ai/presets` | **P0（回归）** | 响应体全文搜不到 key 的任何片段；DevTools 网络面板看不到 key |
| F14 | 公共导航复用 | 全站 | P1 | 改 `partials/nav.html` 一次，9 个带侧边栏的页面同步变；`/account`、`/ai-admin`、`/login` 有明确返回入口 |
| F15 | 触屏操作补齐 | `/snake`、`/minesweeper` | P1 | 贪吃蛇支持滑动、扫雷支持长按标记；补齐前卡片与文案不得写「手机电脑都能玩」 |
| F16 | 可访问性整改 | 全站 | P1 | 导航改 `<a aria-current="page">`；筛选 tabs 有 `aria-controls`；卡片改 `<ul><li><a>`；登录弹窗有焦点陷阱 + `Esc` + `aria-live` |
| F17 | 移动端掉帧修复 | 全站 | P1 | ≤820px 时 `background-attachment` 不为 `fixed` |
| F18 | 门禁 cookie 补票端点 | auth | P1 | localStorage 有 token 但 cookie 丢失时，`/login` 自动调 `/api/auth/refresh-cookie` 并回跳，不要求重输密码 |
| F19 | 大包加载体验 | 4 个 minecraft | P2 | 点击后显示「正在加载 14.4MB，请稍候」+ 超时提示，而非白屏 |
| F20 | sitemap / 结构化数据 / 关键词 TDK | — | **P2（暂不做）** | 仅在「决定公开」后启动（见附录 A，不排期） |

---

## 6. 关键技术整改设计（可直接施工）

### 6.1 删除运行时 HTML/JS 字符串 replace（P0，先做这条）

**必须删，因为它现在正在破坏功能，不是代码洁癖。**

逐条核对（`_worker.js` 556–591 行）：

| 补丁 | 匹配串（`_worker.js`） | 源码现状 | 实际结果 |
|---|---|---|---|
| 首页卡片 href | 562 行匹配 `` return `<a class="card …href="/game.html?id=…" role="listitem">` `` | `index.html:388-390` 已是 `const href = g.url \|\| …` | 失效（死补丁） |
| 创建播放器 | 581 行匹配 `const player = document.createElement("ruffle-player");` | `game.html:173-175` 是**跨行三元表达式**，整串并不连续出现 | 落空（`document.createElement("ruffle-player")` 只作为三元表达式的第三分支残留在源码里） |
| **移除 appendChild** | 583 行匹配 `fc.appendChild(player);` | `game.html:186` **仍是这一行** | **命中并整句删除** → player 从未插入 DOM，Flash 必定黑屏 |
| 改 src 设置方式 | 585 行匹配 `player.setAttribute("src", url);` | `game.html:176` 已是 `player.src = url;` | 落空 |

结论：**四条补丁里三条已与源码脱节（两条落空、一条误删），唯一还在生效的那条正好是破坏性的。** 无论第一/第四条是否命中，运行结果都一样——`player` 从未挂载，画面出不来。误删那条只在 `/game.html` → 308 → `/game` 的第二次请求时触发（`/game.html` 不匹配 `path === "/game"` 分支），所以「有人能玩、有人黑屏」这类偶发现象都能对上。

**施工步骤**

1. `_worker.js` 删除 556–591 两段整块，只保留最后一句 `return env.ASSETS.fetch(request);`。
2. `index.html` 无需改动（href 逻辑源码里已有）。
3. `game.html` 修源码里的挂载顺序——**这是本项唯一必须改的源码**，且必须与第 1 步同一次提交：
   ```js
   const player = window.RufflePlayer.newest().createPlayer();
   fc.appendChild(player);          // ① 先挂载（Ruffle 0.6 要求元素已连接才触发加载）
   player.addEventListener("loadedmetadata", onLoaded);
   player.addEventListener("error", onError);
   player.src = "/api/swf?id=" + encodeURIComponent(id);   // ② 后设 src
   ```
   同时删掉 `document.createElement("ruffle-player")` 这个 fallback 分支（Ruffle 未加载时它拿不到元素，本身就是伪兜底，改为在 `RufflePlayer` 不存在时直接走错误态提示「模拟器加载失败，请刷新」）。保留 `#flashBox` 的 `aspect-ratio:4/3` 占位，避免挂载瞬间高度塌陷。
4. 构建期检查（`scripts/build.mjs`）：若 `_worker.js` 出现 `.replace(` 且同行含 `<` 或 `html`，构建失败并提示「禁止在 Worker 里改 HTML」。
5. **附带收益（这就是 F5 的一半）**：删掉改写后，Worker 不再 `await resp.text()` 缓冲整个 HTML 再重建 Response，HTML 恢复流式直出。**当前 1.2–1.7s 的首字节延迟，主要嫌疑就是这一步。**

**验证方式（不许只看代码改没改）**：部署后用**真实登录态**打开 `/game?id=bleshui-vs-huoYing-3.3`，必须看到 Ruffle 画布出现并进入游戏片头；再打开 `/game?id=bh32` 对应的 3.2 版复验一次。两项都出画面才算过。若仍黑屏，先看控制台是否有 `RufflePlayer is undefined`（jsDelivr 被墙/被 CSP 拦），再看 `#flashBox` 里是否有 `<ruffle-player>` 节点（没有就是挂载顺序又错了）。

---

### 6.2 游戏数据单源化（P0）

**结论：`games.json`（根目录静态文件）为唯一真相源；`_worker.js` 运行时用 `env.ASSETS.fetch()` 读它并做模块级内存缓存。**

三选一对比：

| 方案 | 判断 |
|---|---|
| 内嵌数组在 `_worker.js`（现状） | ❌ 与 `games.json` 双源，**已实际漂移**（`swf:"bh32.swf"` vs `"/swf/bh32.swf"`）；且每加一款游戏都要动 Worker 代码，改一次冒一次风险 |
| 存 KV | ❌ 数据由站长编辑、不由用户产生；多一次网络读、多一套一致性问题、多一条部署步骤，零收益 |
| **静态 JSON + 运行时读 + 内存缓存** | ✅ 一处声明；Worker 只冷启动读一次；`/api/games` 与 `/api/swf` 共用；新增游戏改 JSON 而非改代码 |

**实现**

```js
let gamesCache = null, gamesJsonCache = null;
async function getGames(env) {
  if (gamesCache) return gamesCache;
  const r = await env.ASSETS.fetch("https://internal/games.json");   // 内部请求，不走公网
  gamesCache = r.ok ? await r.json() : [];
  gamesJsonCache = JSON.stringify(gamesCache);                        // 预序列化，避免每请求 stringify
  return gamesCache;
}
```

- `/api/games` 直接返回 `gamesJsonCache`，头：`Content-Type: application/json; charset=utf-8` + `Cache-Control: public, max-age=60`。
- `ASSET_IDS`（`bh32.swf → 629342885` 这类资产 ID）**留在 `_worker.js`**：属于密钥侧配置，不写进公开可读的 JSON。
- `scripts/build.mjs` 校验并在失败时退出：`id` 唯一、`type ∈ {h5,flash}`、flash 项必须有 `swf` 且 `ASSET_IDS` 有对应项、h5 项必须有 `url`、`icon` 文件存在。
- `swf` 字段统一只存文件名（`bh32.swf`），播放地址由 Worker 拼 `/api/swf?id=`，杜绝「/swf/bh32.swf」这种死路径再现。

**`/api/swf` 的防护结论：不加额外限流。** 整站都在门禁内，匿名访客拿不到页面也拿不到播放地址，`/api/swf` 天然只对登录用户可用；再叠 Referer 校验与 IP 限流只是给正常用户加故障点（Referer 在隐私设置下可能为空，误伤率高于收益）。保留现有的 Cloudflare Cache API 缓存即可——它同时解决了「同一条 65MB 文件被反复回源 GitHub」的成本问题。原 v2 里写的 Referer + 429 方案**撤销**。

---

### 6.3 真 404 与正确的 robots.txt（P0，1 小时内可完成）

**这不是 SEO，是修错配**：现在 `/robots.txt` 返回 `text/html` + 首页内容（实测 200 / 28989 字节），等于对外声明「我的 robots 规则就是一张网页」。

**根因**：Cloudflare Pages 在产出目录**没有 `404.html`** 时按 SPA 处理，未命中路径一律 `200 + index.html`（已实测）。平台默认行为，不是你写错了。

**三层修复，全部落地**

| 层 | 做法 | 文件 |
|---|---|---|
| L1 | 根目录放**真实 `404.html`**（H1「页面不存在」+ 回首页 + 3 个游戏入口）。Pages 检测到它之后，未命中路径返回真 404 | `404.html` |
| L2 | Worker 兜底：路径以 `.xml/.txt/.json/.js/.css/.png/.jpg/.jpeg/.svg/.ico/.webp/.map/.webmanifest` 结尾，且 `env.ASSETS.fetch()` 返回 `Content-Type: text/html` → 判定软 404，改返回 `404.html` 内容 + `status:404` | `_worker.js` |
| L3 | 根目录放**真实 `robots.txt`**，`Content-Type` 由 Pages 按扩展名给 `text/plain` | `robots.txt` |

**`robots.txt` 内容（最终版，一个字节都别加）**

```
User-agent: *
Disallow: /
```

不加 `Sitemap:` 行（不生成 sitemap），不加 `Allow`（与 `Disallow: /` 并存只会让规则变复杂）。

**`/sitemap.xml`**：不创建文件，让它自然 404（L1/L2 保证它是真 404，而不是首页）。

**`X-Robots-Tag` 兜底**：`_headers` 对 HTML 加

```
/*
  X-Robots-Tag: noindex, nofollow
```

同时每个页面 `<head>` 加 `<meta name="robots" content="noindex, nofollow">`。三层冗余是故意的：门禁哪天被误改，双保险还能挡住收录。

**`_headers` 是否生效**：Pages 的 `_headers` 作用于**静态资源响应**（含 HTML）。本方案删掉了 Worker 的 HTML 改写，HTML 全部由 `env.ASSETS.fetch()` 直出，所以 `_headers` 能正常生效——这是删改写的第二个附带收益。API 与 302 响应由 Worker 自己加头。

**验收**：F3、F4。

---

### 6.4 登录态校验的性能与体验（P0）

**拆成四块，逐块解决，别混在一起改。**

#### (a) 首字节慢：根因是响应体缓冲，不是 KV

门禁之后紧跟 HTML 改写，`await resp.text()` 必须读完整个 HTML 才能返回第一个字节。结果：无法流式下发、无法边缘缓存、每次都要等 Worker 与 ASSETS 完成一次完整 RTT。**6.1 删掉改写后此项自动消失**——这就是 6.1 必须排第一的原因。

#### (b) 每页一次 KV 读：改 HMAC 签名门禁 cookie，页面路径 0 次 KV

**`ghub_gate` cookie = `base64url(username).exp(ms).base64url(HMAC-SHA256(username + "." + exp, SESSION_SECRET))`**

- 校验：拆 3 段 → 重算 HMAC → 常数时间比较 → 检查 `exp`。**全程纯 CPU，0 次 KV 读**（Web Crypto 在 Worker 原生实现，<1ms）。
- 签发点三处：`/api/auth/login`、注册后自动登录、`/api/auth/change-username`。
- 有效期 30 天，与 `sess:` 一致；`HttpOnly; Secure; SameSite=Lax`。
- 新增环境变量 `SESSION_SECRET`（32 字节随机串）。**运维手段**：轮换它 = 一次性让所有门禁 cookie 失效（全员重登），不必逐条清 KV。
- **撤销能力的取舍**：HMAC cookie 无法单人撤销（直到过期）。可接受，因为 **API 仍走 KV 会话**（`getAuth`），涉及写操作与权限的请求依然能即时撤销；门禁 cookie 只决定「能不能看到页面壳」。若将来需要单人踢下线，加 `denylist:<username>` KV 键在门禁里查（那就又回到一次 KV 读，故不默认做）。
- **已裁定：走 HMAC**（结论见 §11）。以下回退方案仅作备忘，不再实施：保留 KV 校验 + 门禁里加 60 秒边缘缓存（`caches.default` 缓存 `sess:<token>`）。

#### (c) 双跳 + 不回跳：一次跳转 + `next`

- 302 目标改 `/login?next=<encodeURIComponent(pathname + search)>`，不再写 `/login.html`（Pages 会 308 到 `/login`，等于每次多一跳）。
- `/login` 读取 `next`，**必须校验**：只接受以 `/` 开头、不以 `//` 开头、不含 `\`、长度 ≤200 的字符串，否则丢弃用 `/`（防开放重定向）。
- 登录成功：`location.replace(next || "/")`。
- 已持有有效 `ghub_gate` 却访问 `/login`：直接 `location.replace(next || "/")`，不显示登录框（避免「明明登录了还让我登录」）。

#### (d) 顺带修

`doLogout()` 里 `location.href = "/login.html"` 改 `/login`（少一跳）。

**验收**：F5、F6。TTFB 用 `curl -o /dev/null -w "%{time_starttransfer}\n" -H "Cookie: ghub_gate=<有效值>" $B/`，改造前后各测 5 次取中位数。

---

### 6.5 AI 代理：保留形态，加限流（P0）

**形态明确保留**：预设模型对**所有登录用户可见可用**（消耗站长 Key），同时允许用户自带 Key；预设 `key` 永不下发前端（现状正确，列为回归项）。要解决的只是「不能被刷爆」。

#### (a) 阈值（建议直接采用；要调只调数字，不改结构）

| 维度 | 键 | 阈值 | 超限码 | 回给前端的 `window` / `resetAt` |
|---|---|---|---|---|
| 单用户/小时 | `aiq:uh:<user>:<YYYYMMDDHH>` | 30 次 | 429 `user_rate_limited` | `"hour"` / 下一个整点 |
| 单用户/天 | `aiq:u:<user>:<YYYYMMDD>` | 100 次 | 429 `user_rate_limited` | `"day"` / 次日 00:00（UTC+8） |
| 单 IP/小时 | `aiq:ip:<ip>:<YYYYMMDDHH>` | 60 次 | 429 `ip_rate_limited` | `"hour"` / 下一个整点 |
| 全站/天（熔断） | `aiq:all:<YYYYMMDD>` | 300 次 | `global_quota_exceeded` | 无 `window` / 次日 00:00（UTC+8） |

**判定优先级（必须按此顺序，否则文案会错档）**：先查全站日 → 再查用户日 → 再查用户小时 → 最后查 IP 小时；**用户小时与用户日同时命中时回日档**（`window:"day"`）。这样一个当天已用完的用户不会被告知「20 分钟后再试」，避免他白等一轮又撞墙。

为什么是这些数：**KV 免费写额度 1000 次/天**，每次调用要写 4 个计数键 → 300 次全站调用正好打满 1200 次写。全站日上限 300 是配额倒推的硬约束，不是拍脑袋。升级套餐后把 `aiq:all` 提到 2000 即可，其余不动。

#### (b) 实现要点

1. **先读后写，任一超限立刻返回**；不要为了「记一次」先写。
2. 并行读：`Promise.all` 4 个 `get`；写入用 `ctx.waitUntil()` 异步，**不阻塞响应**（计数写失败也不影响对话成功——宁可放过一次，也别让用户白等）。
3. `expirationTtl`：小时键 3600、日键 86400，靠 TTL 自动清；**不要用 delete**（delete 也占免费额度）。
4. 计数是**近似限流**：KV 最终一致，并发下可能多放 1–2 次。这是刻意取舍——精确限流要 Durable Object，这个量级不值得。
5. 请求体上限（控成本比限流更有效）：
   - `messages.slice(-10)`（现为 -20）
   - 所有 `content` 字符总数 ≤8000（超出按尾部截断）
   - **`max_tokens` 默认 800**（200–2000 可传）。现在完全没传，上游默认可能给到 4k，单次成本是数倍。
6. 超限返回体必须带上窗口信息（前端靠它选措辞、算倒计时），三种形态如下：
   ```json
   // 小时档
   { "error": "这一小时聊得有点多，歇一会儿再来", "code": "user_rate_limited", "window": "hour", "resetAt": 1792280400000 }
   // 日档（小时档与日档同时命中时也回这一种）
   { "error": "今天的次数用完了，明天再来", "code": "user_rate_limited", "window": "day", "resetAt": 1792339200000 }
   // 全站熔断（无 window）
   { "error": "今天全站的额度用完了，明天再来", "code": "global_quota_exceeded", "resetAt": 1792339200000 }
   ```
   `resetAt` 一律用 **epoch 毫秒**，由服务端算好，不要返回「还有几分钟」这种相对值。
7. **日界与整点的算法固定按 UTC+8**：`resetAt`（日档）= 以 UTC+8 计的次日 00:00 对应的 epoch 毫秒；小时档 = 下一个整点。日键后缀 `YYYYMMDD` 也用 UTC+8 生成，**两处必须是同一套计算**，否则会出现「键还在限流、`resetAt` 却已过期」的矛盾（Worker 默认跑 UTC，直接用 `new Date()` 取日期会偏移 8 小时）。
   **实现坑（务必写进代码注释）**：**禁止用 `new Date().getHours() + 8` 或任何本地时区方法**——运行环境时区不可依赖，而且 `getHours()` 返回 0–23，加 8 之后不取模，跨零点必错（22 点会被算成 30 点）。统一写法：
   ```js
   const cn = new Date(Date.now() + 8 * 3600 * 1000);      // 平移到 UTC+8 的“墙上时间”
   const ymd = cn.toISOString().slice(0, 10).replace(/-/g, "");   // 20261017  ← 日键后缀
   const ymdh = cn.toISOString().slice(0, 13).replace(/[-T]/g, ""); // 2026101716 ← 小时键后缀
   const nextDayCn = Date.UTC(cn.getUTCFullYear(), cn.getUTCMonth(), cn.getUTCDate() + 1) - 8 * 3600 * 1000; // 次日 00:00(UTC+8) 的 epoch ms
   const nextHour = Math.ceil(Date.now() / 3600000) * 3600000;    // 下一个整点（绝对时刻，与时区无关）
   ```
   要点：算日界用 `Date.UTC(...)` 再减 8 小时回落到 epoch，不要用字符串拼日期再 `new Date("2026-10-18 00:00")`（各引擎对无时区字符串的解释不一致）。
8. **让站长看得见**（P1-8）：`/ai-admin` 顶部显示「今日已用 N / 300」，读 `aiq:all` 即可。

#### (c) 与限流无关但必须保住的两条

- `GET /api/ai/presets` 出参过滤 `key`（**回归项 F13**）。
- 用户自带 Key 时 `baseURL` 内网拦截（防 SSRF，P1-7）：拒绝非 `https`、拒绝 `localhost / 127. / 10. / 192.168. / 169.254. / [::1] / *.local / *.internal`。

---

### 6.6 管理员抢注（P0）

现状 `_worker.js:269-271`：用 `KV.list({prefix:"user:"}).keys.length === 0` 判「我是第一个」→ 谁先注册谁是管理员（还顺带每次注册扫一遍全表）。

**修复**

1. 新增环境变量 `ADMIN_SETUP_CODE`（32 位随机串）。
2. `admin = 提供了 setup_code && timingSafeEqual(body.setup_code, env.ADMIN_SETUP_CODE)`；未配置该变量时一律 `admin:false`（安全默认）。
3. 删除 `KV.list` 判定分支。
4. 存量：已存在 `user:` 记录里的 `admin:true` 继续有效，站长账号不受影响。
5. 前端：注册表单**默认不显示** `setup_code` 输入框，仅当 URL 带 `/#setup` 时出现（不主动暴露字段存在）。
6. 兜底（写进 README）：忘了 code 时用
   `npx wrangler kv key put --binding=MSG_KV "user:<name>" '{"salt":"…","hash":"…","admin":true}'`
   手工置位；或临时把 `ADMIN_SETUP_CODE` 设成新值再注册一个管理员。

**验收**：F8。

---

### 6.7 留言板并发写丢数据（P0）

现状：`msgs` 单键 read-modify-write（`get` → `push` → `put`）。两个请求同时到，后写覆盖前写，必丢。`change-username` 还在同一键上做第二次 RMW，风险叠加。

**修复：一条留言一个 KV 键。**

- 键：`msg:<id>`，其中 `id = padStart(13,'0', 9999999999999 - Date.now()) + '-' + randHex(3)`。前 13 位是倒序时间戳，`KV.list` 的字典序天然 = 时间倒序，取最近 50 条不需要排序。
- 写：`put('msg:'+id, JSON.stringify(msg), { expirationTtl: 365*86400 })` —— 单键单写，无竞争。
- 读：`KV.list({ prefix:'msg:', limit:50 })` → `Promise.all` 并行 `get` → 返回数组；加 15 秒边缘缓存（`caches.default` + `ctx.waitUntil`），把「每次刷留言板 50 次 KV 读」压到「每 colo 每 15 秒 50 次」。
- 删：先 `get` 校验存在（否则 404 `msg_not_found`），再 `delete('msg:'+id)`。
- **存量迁移**：首次请求时若 `migrated:msgs2` 不存在，则读旧 `msgs` → 逐条 `put` 到 `msg:<id>`（旧 id 已是 base36 时间戳，直接复用，缺失时用当前时间）→ 写 `migrated:msgs2` 标记。**旧键 `msgs` 保留 30 天不删**，读取时若存在则合并展示（防回填失败丢留言）。
- `change-username` 不再改写历史留言：留言里的 `name` 是发布时快照。代价是改名后旧留言显示旧名；换来不再有第二次 RMW。这个交换是划算的——显示名不重要，数据完整性重要。

**验收**：F9（10 并发写 → 10 条都在）。

---

### 6.8 Cookie 与 CSP（P0）

#### (a) Cookie

```
Set-Cookie: ghub_token=<token>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax
Set-Cookie: ghub_gate=<username>.<exp>.<hmac>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax
```

- `Secure`：全站 HTTPS，无条件加。
- `HttpOnly`：前端只用 localStorage 的 token 调 API，**不读 cookie**，所以零副作用，白赚一层 XSS 防护。
- `SameSite=Lax`：AI iframe 是跨站的，但它用 Bearer 不用 cookie，不受影响。
- 登出：两个 cookie 都 `Max-Age=0` 清掉，并删 KV 会话。

#### (b) CSP：必须用折中值，否则一上就白屏

站点大量内联 `<style>`/`<script>`，Ruffle 还要 WASM 与 blob worker。**严格 CSP 会立刻白屏，这不是「再优化一下」能绕过的**，所以采用折中版：

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' https://cdn.jsdelivr.net; worker-src 'self' blob:; frame-src 'self' https://4m8dv3g0c7b16.doubao.link; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'
```

每个非常规指令的理由：

| 指令 | 为什么必须有 | 少了会怎样 |
|---|---|---|
| `'unsafe-inline'`（script/style） | 全站内联脚本与样式（首页 690 行 CSS+JS 全内联） | 白屏 |
| `'wasm-unsafe-eval'` | Ruffle 0.6 用 WebAssembly 跑 SWF | 所有 Flash 页黑屏 |
| `worker-src blob:` + `img-src blob:` | Ruffle 用 blob worker 与 canvas | Flash 加载失败 |
| `connect-src cdn.jsdelivr.net` | Ruffle 运行时拉 `.wasm` | Flash 加载失败 |
| `frame-src …doubao.link` | 首页 AI 助手 iframe | AI 面板空白 |
| `object-src 'none'` | 唯一真收益：禁止 `<object>/<embed>` 类老式注入 | — |
| `frame-ancestors 'self'` | 禁止被别的站套框 | — |

**落地路径（不要一步上正式）**

1. 先用 `Content-Security-Policy-Report-Only:`（同值）跑 24 小时，看控制台违规。
2. 逐项人工验证：首页、`/tools`（qrcode + marked 两个外链库）、`/game?id=`（Ruffle）、`/ai-admin`（跨站 iframe）、4 个 minecraft 大包。
3. 全绿后再切正式头。

**其他安全头**

```
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=()
```

**分工**：静态 HTML/资源走 `_headers`；API 与 302 响应由 `_worker.js` 的 `SECURITY_HEADERS` 统一加。

**验收**：F10、F11。

---

### 6.9 首页首屏静态渲染（P0，理由是体验不是 SEO）

**目标**：首屏少一次请求往返、没有骨架屏闪一下。**与收录无关**（站点不索引），所以只做到「HTML 里就有卡片」为止，不做各页预渲染、不做 `/play` 包装页。

**方案：构建期注入卡片块**

- `index.html` 放占位：`<ul class="grid" id="grid" role="list"><!--@build:game-cards--></ul>`
- `scripts/build.mjs`（零依赖，Node ≥ 18）从 `games.json` 生成 9 个 `<li><a class="card">…</a></li>` 注入。
- 同时注入 `<script type="application/json" id="gamesData">…</script>`，供筛选/计数在客户端同步计算（**不再 `fetch('/api/games')`**）。
- 计数条（共 9 款 / Flash 2 / H5 7）在构建期算好写进 HTML，避免「卡片 9 张、计数写 10」。
- 删除 `.skeleton` 样式与 `load()` 里的骨架屏逻辑；`/api/games` 仍保留（播放页要用）。
- 卡片用真实游戏名，占位图必须带 `width`/`height` 与 `alt`，避免 CLS。

**构建步骤是硬前置**：既然发布目录改成 `dist/`，`node scripts/build.mjs` 必须执行，卡片注入是顺带完成的事，不存在「跳过构建但保留 dist」的选项。因此 F7 没有降级路径；唯一要防的是「忘了跑构建就上传」——用 Pages Git 集成（Build command 自动执行）来消除这个人为环节。

**验收**：F7。

---

### 6.10 可访问性与移动端（P1，清单式执行）

1. 导航 `role="tablist"/"tab"` → 普通 `<nav><a aria-current="page">`（导航不是 tab）；tab 语义只留在真的面板切换（`/tools`、首页类型筛选）。
2. 首页筛选 tabs 补 `aria-controls="grid"`，`#grid` 加 `role="tabpanel"`。
3. 卡片 `<a role="listitem">` → `<ul role="list"><li><a>`（`<a>` 上不要放 `listitem`）。
4. 登录弹窗：焦点陷阱 + `Esc` 关闭 + 关闭后焦点归位 + 错误容器 `role="alert" aria-live="polite"` + 背景 `inert`。
5. `background-attachment: fixed` 在 ≤820px 改 `scroll`（移动端掉帧）。
6. 对比度：`--dim:#8a92b8` 在深底约 4.0:1，正文小字提到 `#9aa3c7`。
7. 标题层级：补齐各页 H1；首页 `view-ai` 里那个 `<h1>AI 助手</h1>` 改 `<h2>`（一页两个 H1）。
8. 贪吃蛇加滑动、扫雷加长按标记（**补齐前卡片文案不得写「手机电脑都能玩」**）。

---

## 7. 技术栈与托管结论

| 项 | 结论 | 理由 |
|---|---|---|
| 托管 | **继续 Cloudflare Pages** | 已有 `MSG_KV`、`ASSETS`、`GH_TOKEN`、HTTPS 与 CDN；迁移不解决任何一条本轮缺陷，只会把「改代码」变成「改平台 + 改代码」 |
| Worker 模式 | 保留 advanced mode 单文件 `_worker.js`，**职责收缩为「路由 + API」** | 路由可控正是精确门禁与真 404 需要的；一旦它开始改 HTML，就会重演「补丁静默失效」 |
| 前端 | 纯 HTML/CSS/原生 JS，**不引框架** | 15 个页面、交互简单；引框架后首屏从 HTML 变 JS 渲染，与本轮「消骨架屏」目标相反 |
| 构建 | `scripts/build.mjs`，**零依赖 Node ≥ 18**，只做 4 件事：`src/ + bundles/ + data/ → dist/` 拷贝、注入首页卡片块与内联 JSON、校验 `games.json`、检查 Worker 无 HTML replace | 构建期分发是唯一能根治双源的方式；运行时分发已证明会反噬（就是 6.1 那个补丁）。顺带把 `_backup/`、`scripts/`、`partials/` 挡在发布面之外 |
| 发布目录 | **改为 `dist/`**（Pages：Build command `node scripts/build.mjs`，Output directory `dist`） | 把 `_backup/`、`_shots/`、`scripts/`、`partials/`、`docs/` 挡在公开面之外——现在它们都能被直接访问，`_backup/index.html` 还是一份完整的重复首页。构建只做「拷贝 + 注入」，大包按原文件名拷贝，**URL 一个都不变** |
| 样式 | 保持 CSS 变量 + 各页 `<style>`；P1 再抽 `assets/app.css` | 现状可用；抽取是维护性收益，不阻塞 |
| 数据 | **Cloudflare KV**，留言改单键单条 | 量级（几十用户、几百条留言）远低于 KV 单键 25MB 上限；换 D1 要建库 + 迁移 + 改全部读写，换不到对当前规模有意义的收益 |
| 大文件 | 保持 GitHub 私有 Release + `/api/swf` 转发（P2 可迁 R2） | 已在跑；R2 能去掉 `GH_TOKEN` 与 GitHub 速率限制，属优化项 |
| 域名 | 保持 `lhm666888.dpdns.org`，开 HSTS | 已 HTTPS；门禁站点无需备案 |
| 版本管理 | **`git init` + 推 GitHub + Pages Git 集成**（已定，Build command `node scripts/build.mjs`，Output directory `dist`） | 当前无仓库，构建脚本与回滚都无处落地；接 Git 后 push 即构建部署，同时消除「忘了跑构建就上传」这个人为故障点 |

**已知残留（本轮明确接受）**

1. 改用 `dist/` 后源目录不再公开；但 `_backup/index.html`、`_shots/*` 建议仍从仓库删除（P1-9），避免被误拷进 `dist/`。
2. 门禁 cookie 无法单人撤销（靠轮换 `SESSION_SECRET` 批量失效）；API 侧仍可即时撤销。
3. 限流是近似值（KV 最终一致），并发下可能多放 1–2 次。

**环境变量（只列名，不给值）**

| 变量 | 用途 | 位置 | 必填 |
|---|---|---|---|
| `GH_TOKEN` | 读 GitHub 私有 Release 资产 | Pages → Settings → 环境变量（加密） | 是 |
| `ADMIN_SETUP_CODE` | 管理员注册口令 | 同上 | 是（不配则无人可成为管理员） |
| `SESSION_SECRET` | 门禁 cookie 的 HMAC 签名密钥 | 同上 | 是 |

---

## 8. 目录结构约定

```
games-hub/
├── src/                        # 源：只有这里改
│   ├── _worker.js              # 路由 + API。禁止出现对 HTML 的字符串替换
│   ├── _headers                # 静态资源头：CSP / X-Robots-Tag / 缓存
│   ├── 404.html                # 真 404（新增）
│   ├── robots.txt              # User-agent: * / Disallow: /（新增）
│   ├── index.html              # 首页：含 <!--@build:game-cards--> 注入块
│   ├── tools.html
│   ├── media.html
│   ├── guestbook.html
│   ├── login.html
│   ├── account.html
│   ├── ai-admin.html
│   ├── game.html               # Flash 播放页（/game?id=）
│   ├── game2048.html  snake.html  minesweeper.html
│   ├── partials/               # P1：nav.html / footer.html（构建期 include）
│   └── assets/                 # default.svg / bh32.jpg / bh33.jpg / 以后的 app.css
├── bundles/                    # 4 个大包，原样拷贝，不参与模板处理
│   ├── minecraft.html          # 14.4MB
│   ├── minecraft-1122.html     # 19.2MB
│   ├── minecraft-125.html      #  6.0MB
│   └── minecraft-classic.html  #  3.6MB
├── data/
│   └── games.json              # ★唯一数据源（游戏列表）
├── scripts/
│   ├── build.mjs               # src + bundles + data → dist（拷贝 + 注入 + 校验）
│   └── verify.sh               # 部署后 10 条 curl 断言
├── docs/                       # 本文件、content-plan（不发布）
└── dist/                       # ★发布目录（Pages Output directory，git 忽略）
    ├── _worker.js  _headers  404.html  robots.txt
    ├── index.html  tools.html  media.html  guestbook.html …
    ├── games.json
    └── minecraft*.html
```

**Pages 项目设置（改一次）**：Build command `node scripts/build.mjs`，Build output directory `dist`。若走手工上传，就本地跑完脚本后上传 `dist/` 整个目录。

**约定**

| 类型 | 位置 | 规则 |
|---|---|---|
| 页面 | `src/<name>.html` | URL = `/<name>`（extensionless）。站内链接统一写 `/tools` 而非 `/tools.html`，少一跳 308 |
| 数据 | `data/games.json` | 除它之外任何地方出现游戏数组字面量都算 bug（构建会报错） |
| 补丁 | 无 | 任何「用 Worker 改页面内容」的需求，一律改为改源码 |
| 生成物 | 只有 `index.html` 的卡片块与内联 JSON | 构建脚本用 `<!--@build:…-->` 定位，块外内容不得改动 |
| 大包 | `bundles/minecraft*.html` | 原样拷进 `dist/`，不参与模板处理；P0-10 只允许改 `<head>` |
| 发布 | `dist/` | 任何人不得手改 `dist/`；`_backup/`、`_shots/` 不进 `dist/` |

---

## 9. 整改优先级表

### P0（阻塞：功能已坏 / 数据会丢 / 会被刷爆 / 首屏不可用）

| # | 事项 | 影响面 | 改动文件 | 预估 |
|---|---|---|---|---|
| P0-1 | 删除 Worker 两段 HTML 改写；`game.html` 挂载顺序修到源码 | **修复 Flash 黑屏**；去掉响应体缓冲（首屏最大嫌疑） | `_worker.js`、`game.html` | 1.5h |
| P0-2 | 游戏数据单源化（`games.json` + ASSETS 读 + 内存缓存 + 预序列化） | 消除双源漂移（已实际漂移） | `_worker.js`、`games.json` | 2h |
| P0-3 | 真 404 + 正确 `robots.txt` + `X-Robots-Tag` + `meta robots` | 修错配；门禁兜底 | `404.html`、`robots.txt`、`_headers`、`_worker.js`、各页 head | 1.5h |
| P0-4 | 门禁改造：HMAC `ghub_gate`、`?next=` 回跳、单跳、放行 robots/404/api | 首屏 TTFB、登录体验 | `_worker.js`、`login.html`、`index.html`、`account.html`、`ai-admin.html` | 3h |
| P0-5 | 构建脚本 + `dist/` 发布链路 + 首页卡片注入（`src/bundles/data → dist`、卡片刻与内联 JSON、删骨架屏） | 发布面收敛 + 首屏体验 | `scripts/build.mjs`、`index.html`、Pages 设置 | 4h |
| P0-6 | 管理员抢注修复（`ADMIN_SETUP_CODE`） | 站点控制权 | `_worker.js`、`login.html` | 1h |
| P0-7 | 留言改单键单条 + 存量迁移 + 边缘缓存 | 数据不丢 | `_worker.js` | 2.5h |
| P0-8 | AI 限流（用户/IP/全站）+ 请求体上限 + `max_tokens` 默认值 | 成本失控 | `_worker.js` | 2h |
| P0-9 | Cookie `HttpOnly; Secure` + CSP（Report-Only 先行→切正式） | 安全 | `_worker.js`、`_headers` | 1.5h |
| P0-10 | 清 4 个大包 `<head>` 里的第三方英文 `og:*`（含辱骂文案）与英文 title | 分享出去会出丑 | `minecraft*.html`（仅 head） | 0.5h |
| P0-11 | 验收脚本（10 条 curl 断言，含带 cookie 的 TTFB） | 防回归 | `scripts/verify.sh` | 1h |
| **合计** | | | | **~20.5h（2.5 人日）** |

### P1（体验与维护性，上线后 1–2 周）

| # | 事项 | 影响面 | 改动文件 | 预估 |
|---|---|---|---|---|
| P1-1 | 导航/页脚 include 复用；`/account`、`/ai-admin`、`/login` 补导航 | 一致性（现 4 份副本、3 页无导航） | `partials/*`、9 页 | 3h |
| P1-2 | 公共 CSS 抽 `assets/app.css` | 维护性 + 二次访问 | 各页 | 3h |
| P1-3 | 可访问性整改（6.10 第 1–4、6–7 条） | 可用性 | 各页 | 5h |
| P1-4 | 触屏补齐（贪吃蛇滑动、扫雷长按） | 移动端可玩（主人群） | `snake.html`、`minesweeper.html` | 3h |
| P1-5 | 移动端掉帧 + 图片 `width`/`height` | CLS、滚动流畅 | 各页 CSS | 1h |
| P1-6 | `/api/auth/refresh-cookie` 补票端点 + `/login` 自动回跳 | 少一次重复登录 | `_worker.js`、`login.html` | 1.5h |
| P1-7 | `/api/ai/chat` 自带 Key 的 `baseURL` 内网拦截（防 SSRF） | 安全 | `_worker.js` | 0.5h |
| P1-8 | `/ai-admin` 顶部显示「今日已用 N / 300」 | 成本可见 | `ai-admin.html` | 1h |
| P1-9 | 删除 `_backup/`、`_shots/` | 防止被误拷进 `dist/` | 仓库根 | 0.2h |
| P1-10 | README 重写（构建、部署、环境变量、管理员重置、KV 配额注意事项） | 交接 | `README.md` | 1h |
| P1-11 | 核实两款大包的真实版本号：`minecraft-125` 与 `minecraft-classic` 的正文里搜不到任何版本标识，「1.2.5 / Classic 0.30」是站方自拟；且两者 `<title>` 重名（都是 `Eaglercraft Offline`）。核实后统一改 `data/games.json` 的 `name` 与 `<title>` | 数据正确性（玩家会按版本名判断能不能进对应服务器） | `data/games.json`、两个大包 `<head>` | 0.5h |
| **合计** | | | | **~20h** |

### P2（打磨 / 将来放开门禁再做）

| # | 事项 | 触发条件 |
|---|---|---|
| P2-1 | 大包加载体验（进度/超时提示或轻量包装壳） | 有用户抱怨白屏 |
| P2-2 | 全站搜索可见性（sitemap / canonical / JSON-LD / TDK / URL 重构） | **不排期，见附录 A** |
| P2-3 | SWF 迁 Cloudflare R2，去掉 `GH_TOKEN` 与 GitHub 速率限制 | GitHub 额度吃紧 |
| P2-4 | 内联 JS 外链化，CSP 去掉 `unsafe-inline`（改 nonce/hash） | 安全要求提高 |
| P2-5 | 每款游戏一张真实封面（现 7 款共用 `default.svg`；`bh32.jpg`/`bh33.jpg` 实测仅 72×72，被放大到 300px 位必然是糊的，建议重截 640×400） | 内容侧 |
| P2-6 | 留言治理（超 200 条清理、敏感词） | 留言量上来 |
| P2-7 | Cloudflare Web Analytics + 关键动作埋点 | 想看数据 |
| P2-8 | `/tools` 增加 hash 路由（`#qrcode`/`#timestamp`/`#base`/`#text`/`#image`/`#markdown`），让锚点可直达、后退键可用 | 有人要分享单个工具链接 |

---

## 10. 部署后验收清单

```bash
B=https://lhm666888.dpdns.org
# 无 cookie：应 302 到 /login?next=...
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" $B/
# robots：必须 text/plain + Disallow: /
curl -sI $B/robots.txt | grep -i content-type
curl -s $B/robots.txt
# 不存在路径：必须 404（sitemap 也应是 404）
curl -s -o /dev/null -w "%{http_code}\n" $B/definitely-not-here
curl -s -o /dev/null -w "%{http_code}\n" $B/sitemap.xml
# 带有效 cookie：200 + 首屏含卡片 + TTFB
curl -s -H "Cookie: ghub_gate=<valid>" $B/ | grep -c 'class="card'
curl -s -o /dev/null -w "ttfb=%{time_starttransfer}\n" -H "Cookie: ghub_gate=<valid>" $B/
# API：数据单源；预设不泄 key（期望输出 0）
curl -s $B/api/games | head -c 200
curl -s -H "Authorization: Bearer <token>" $B/api/ai/presets | grep -c '"key"'
```

---

## 11. 结尾三行

**范围建议（砍到哪层能上线）**：P0 全部完成需 **~20.5 人时**。P0 内部没有真正可砍的项——P0-5 是 `dist/` 发布链路的地基，P0-11 只值 1 人时，砍了等于带病上线；**最该砍的是 P1（20h）与 P2 全部**。若一定要压到一天内，只做 **P0-1 + P0-3 + P0-6 + P0-8** 四件（5.5 人时），这四条对应「Flash 现在是坏的 / robots 返回 HTML / 管理员可被抢 / AI 额度可被刷」，都是正在发生的故障，其余排下一批。

**最大风险（一句话）**：删掉 Worker 里的 HTML 改写会让 `game.html` 失去「先挂载后设 src」的兜底，**必须同一次提交里把 `game.html` 的源码顺序也改对**（并把 `document.createElement` 那个伪兜底分支删掉），否则 Flash 会从「部分黑屏」变成「全部黑屏」，而这类回归没有任何自动化测试能发现——只能靠部署后真的打开 `/game?id=bleshui-vs-huoYing-3.3` 看一眼画面。

**需要用户拍板的 1–3 个决策**：
1. **部署方式选哪个？** 因为要产出 `dist/`，构建脚本必须有人执行：① `git init` + Pages Git 集成（Build command `node scripts/build.mjs`，Output directory `dist`）——一次配好，以后 push 即上线；② 继续手工上传，每次本地先跑 `node scripts/build.mjs` 再拖 `dist/`。推荐 ①，否则「忘了跑构建」会变成新的静默故障源。
2. **AI 限流按「30 次/小时、100 次/天/用户，IP 60 次/小时，全站 300 次/天」执行吗？** 这组数字由 KV 免费写额度（1000 次/天）倒推；若觉得太紧，需要同意升级 Workers 付费套餐，否则会先把留言与登录的写入挤掉。
3. **`SESSION_SECRET` 轮换即全员重登**这一运维代价能否接受？能 = 门禁走 HMAC（页面 0 次 KV 读，首屏最快）；不能 = 保留 KV 校验加 60 秒边缘缓存（首屏保留一次 KV 读，约几十毫秒）。

---

## 附录 A：若未来开放搜索的迁移路径（不排期，仅备忘）

**触发条件**：用户明确决定「对搜索引擎开放」。在那之前本文任何一节都不执行下面的内容。

到那一天按此顺序做，顺序不能反（先有内容，再谈索引）：

1. **改门禁**：把 `/`、`/tools`、`/media`、`/guestbook`、游戏页改为公开；只保留 `/account`、`/ai-admin`、写接口的鉴权。同时在 `_worker.js` 里把「页面级 cookie 门禁」与「API Bearer 鉴权」彻底分开。
2. **真 404 与 robots 反转**：`404.html` 保留；`robots.txt` 改为 `Allow: /` + `Disallow: /api/`、`/account`、`/ai-admin`、`/bundles/`；`_headers` 的 `X-Robots-Tag` 只对 `/bundles/*` 保留。
3. **URL 语义化重构**：`/game?id=x` → `/play/<slug>`，4 个大包移出首屏、改为 `/play` 页点击后 iframe 加载。**在零索引时做，成本最低；一旦有排名再做，等于自毁。**
4. **页面级预渲染**：把构建脚本从「只注入首页卡片」扩到「为每款游戏生成静态包装页」，HTML 里要有 H1、版本、体积、操作说明、相关游戏。
5. **可索引元信息**：每页唯一 `<title>`（含目标词）、`description`、`canonical`（extensionless）、`og:*`、`twitter:card`；首页 `WebSite`+`ItemList` JSON-LD，游戏页 `VideoGame`+`BreadcrumbList`。
6. **sitemap.xml**：由构建脚本从 `data/games.json` 生成，只放真实可访问的 URL，全部 extensionless；`robots.txt` 末尾加 `Sitemap:` 行。
7. **重开关键词与文案**：恢复内容策划里被推后的关键词地图、首页结构文案的检索导向论证、内链策略、素材 `alt` 规范。

**提前准备好的两件事**（现在做也不吃亏）：目录已被构建脚本接管（第 3、4 步不需要重构项目）；`data/games.json` 已是单一真相源（第 6 步可直接生成 sitemap）。

---
