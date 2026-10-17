# 游戏中心 (games-hub)

免费游戏站，部署于 Cloudflare Pages，零服务器成本、无需绑定支付卡。

## 架构

| 组件 | 说明 |
|---|---|
| **Cloudflare Pages** | 托管页面（首页 + 游戏播放页），自动构建部署 |
| **Pages Functions** | `/api/games` 游戏列表接口、`/api/swf` 大文件 SWF 转发 |
| **GitHub Release** | 存放 >25MB 的 SWF 文件（绕过 Pages 单文件限制，私有仓库 + Token） |
| **Ruffle 0.6.0** | 浏览器内 Flash 模拟器，在线运行 SWF（jsDelivr 固定版本） |

## 游戏

- 死神VS火影 3.2（Flash，58.9MB）
- 死神VS火影 3.3（Flash，65.9MB）

## 页面功能

- 首页：类型筛选（全部 / Flash / H5）、游戏计数、骨架屏加载、失败重试、键盘方向键切换筛选
- 播放页：Ruffle 在线模拟、全屏切换、加载提示（大文件提示 1-3 分钟）、加载失败重试、键盘操作提示
- 所有页面内置 SVG favicon，支持移动端适配

## 数据源说明

游戏列表以 `_worker.js` 内嵌数组为**权威数据**（部署时随 Worker 更新）；
`games.json` 为本地开发参考副本，新增游戏时两处需同步。

## 新增游戏流程

1. 将 SWF 上传至 GitHub Release（私有仓库 `snowandstar/games-assets`），记下资产 ID
2. 在 `_worker.js` 的 `ASSET_IDS` 中新增 `文件名: 资产ID`
3. 在 `_worker.js` 的 `games` 数组与 `games.json` 中新增游戏条目（id / name / type / size / icon / swf）
4. 封面图（如 `bh34.jpg`）放入仓库根目录，`icon` 填 `/bh34.jpg`
5. 推送触发 Cloudflare Pages 自动部署

## 环境变量

| 变量 | 说明 |
|---|---|
| `GH_TOKEN` | GitHub fine-grained token，需有目标 Release 资产的读取权限（在 Cloudflare Pages 项目设置中添加） |

## 部署

1. 本仓库推送到 GitHub → 自动触发 Cloudflare Pages 构建
2. SWF 大文件上传到 GitHub Release `v1.0`：
   - `bh32.swf`（死神VS火影3.2）
   - `bh33.swf`（死神VS火影3.3）
3. 页面通过 `/api/swf?id=xxx` 由 Pages Function 从 Release 转发

## 本地开发

```bash
npx wrangler pages dev .
```

> 注意：本地开发需配置 `GH_TOKEN` 环境变量（`--binding GH_TOKEN=xxx`），否则 `/api/swf` 返回 500。
