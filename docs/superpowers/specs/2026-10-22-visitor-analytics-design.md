# 访问统计设计（静态站点 + Cloudflare Worker）

日期：2026-10-22
状态：待评审

## 1. 意图（为什么做）

站点 `charlesyang08.github.io` 是一个纯静态的甜品作品集（单个 `index.html`，GitHub Pages 托管）。
站主想知道：**谁在什么时候来看过、从哪里来、访问量大概多少**。

"谁" 的粒度已确认：IP + 城市，不记录运营商、设备或 User-Agent。站主接受这一限制。

## 2. 目标与非目标

### 目标
- 记录每一次页面访问：精确时间（UTC）、真实 IP、国家、城市、来源页。
- 提供一个**桌面优先、带图表**的查看面板：访问量趋势、来源排行、国家 / 城市排行、最近访问明细。
- 全部运行在免费额度内，不绑信用卡。
- 尽量少改动现有站点：`index.html` 只加一个很小的采集脚本和一行隐私说明。

### 非目标
- 不识别具体个人（不做登录、不做跨站追踪、不建用户画像）。
- 不记录运营商 / ASN、User-Agent、设备型号、屏幕尺寸、语言、访问路径。
- 不做会话录制、热图、A/B 测试。
- 不追求 GDPR 级别的完整合规体系（只做基本告知与数据最小化）。
- 不做实时（秒级）看板；分钟级延迟可接受。

### 反目标（即使技术上做到了也算失败）
- 因为记录访问而明显拖慢页面、增加体积或引起报错。
- 让访客 IP 暴露在公开页面上，或让统计接口可被任意人读取。
- 为了免费而在页面里塞第三方广告或追踪 SDK。

## 3. 约束

- GitHub Pages 纯静态、无服务端；浏览器无法读取访客 IP。
- 外部依赖仅限：Cloudflare 免费账号（Workers + D1）。
- 免费额度：Workers 10 万请求/天；D1 5GB 存储、500 万行读/天、10 万行写/天。
- 站点是英文作品集。**所有网页端交付物（页面 UI、图表标签、Worker 代码与注释、接口返回的错误信息、采集脚本）一律使用英文，不得出现任何中文。** 给站主看的说明文档（如 `worker/README.md`）可以用中文，与站主的交流也用中文。
- 访客与站主主要从中国大陆以外访问，`workers.dev` 端点可正常使用；不引入自定义域名。
- 部署由构建者执行：站主提供权限最小化的 Cloudflare API token 与 Account ID，构建者用 `wrangler` 创建 D1、部署 Worker、设置 secret。token 只通过环境变量使用，不写入仓库或任何交付文件，部署完成后建议吊销。
- Windows 环境；`wrangler` 通过 `npx` 运行，不要求全局安装。

## 4. 架构

```
访客浏览器
  │  1. 打开 index.html
  │  2. fetch POST /collect（小 JSON，keepalive）
  ▼
Cloudflare Worker  (visitor-stats.<account>.workers.dev)
  │  - 读取 CF-Connecting-IP
  │  - 读取 request.cf: country / city
  │  - UA 仅在内存中用于 bot 判定，不写入数据库
  │  - 写入
  ▼
Cloudflare D1 (SQLite)  ──表 visits──
  ▲
  │  3. GET /stats（Authorization: Bearer <STATS_KEY>）
  ▼
stats.html（GitHub Pages 上的静态面板，输入一次口令后存 localStorage）
```

要点：
- Worker 由浏览器**直连**，所以它看到的就是访客真实 IP；GitHub Pages 不需要改动托管方式、也不需要自定义域名。
- 站点与 Worker 不同源（`charlesyang08.github.io` → `*.workers.dev`），需要 CORS：
  - `/collect`：允许 `Origin: https://charlesyang08.github.io`（同时允许 `http://localhost:*` 便于本地测试）。
  - `/stats`：允许同样的 Origin，允许 `Authorization` 请求头。
- 采集与查询在同一个 Worker，用路径区分。

## 5. 数据模型（D1）

```sql
CREATE TABLE IF NOT EXISTS visits (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT    NOT NULL,   -- ISO 8601 UTC, e.g. 2026-10-22T08:15:03.120Z
  ip        TEXT    NOT NULL,   -- CF-Connecting-IP
  country   TEXT,               -- ISO-3166 alpha-2
  city      TEXT,
  referrer  TEXT,               -- hostname or "(direct)"
  is_bot    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits(ts);
CREATE INDEX IF NOT EXISTS idx_visits_country ON visits(country);
CREATE INDEX IF NOT EXISTS idx_visits_referrer ON visits(referrer);
```

- 只存服务端能拿到的字段 + 浏览器上报的来源页；不设 cookie，不用 IP 做跨天追踪。UA 只在 Worker 内存中用于判断 `is_bot`，不落库、不展示。
- 独立访客按 `COUNT(DISTINCT ip)` 估算；同一 IP 多次访问算一个。
- `is_bot` 按 UA 里的 `bot|crawl|spider|headless` 等关键字粗判；面板默认排除 bot，可切换显示。
- 保留期：一年。Worker 加一个每日 `scheduled` 任务删除 `ts` 早于 365 天的行。
- 时区：`ts` 一律存 UTC；面板的 `daily` 分桶与 `days=N` 窗口边界按 Asia/Shanghai（UTC+8）计算，采用 `date(ts, '+8 hours')`，面板标注 "Daily in Asia/Shanghai"。最近访问明细的时间由浏览器按本地时区显示。

## 6. 接口

### `POST /collect`
请求体（`application/json`，`keepalive: true`）：
```json
{ "referrer": "https://..." }
```
- `index.html` 在 `</body>` 前插入的脚本负责发送；同一标签页每次加载发一次，不做停留时长追踪。
- 服务端补充 IP、国家、城市、服务器时间；UA 只用于判定 `is_bot`，不存储。
- 成功返回 `204`；任何解析错误也返回 `204`（采集端永不报错、不阻塞页面）。
- 不校验来源（无法伪造，公开采集端点本就如此），但限制请求体 < 2KB。

### `GET /stats?days=30`
- 鉴权：`Authorization: Bearer <STATS_KEY>`（Worker 环境变量 / secret）。
  错误 key 返回 `401`。
- 返回 JSON：
  - `totals`: 总访问、独立访客（`COUNT(DISTINCT ip)`）、bot 数、不同国家数、不同来源数。
  - `daily`: `[{date, visits, uniques}]`
  - `top_referrers`: `[{referrer, visits}]`（空来源归一为 `(direct)`）
  - `top_countries`: `[{country, visits}]`
  - `top_cities`: `[{city, country, visits}]`
  - `recent`: 最近 200 条明细（含时间、IP、国家、城市、来源）
- 所有聚合都带 `is_bot = 0` 默认过滤；`recent` 同理，面板提供“包含机器人”开关。

## 7. 查看面板 `stats.html`

- 放在仓库根目录，GitHub Pages 发布为 `https://charlesyang08.github.io/stats.html`。页面本身公开，但**没有口令拿不到数据**。
- 首次打开要求输入 `STATS_KEY`，校验通过后存 `localStorage`；提供“退出 / 清除口令”。
- 桌面优先布局（宽度 ≥ 1024px 效果最佳，窄屏可读不崩）：
  - 顶部：时间范围切换 7 / 30 / 90 天；4 个数字卡（总访问、独立访客、来源种类、国家数）。
  - 中部：按天访问量折线图；来源 Top 10 横向条形图；国家 / 城市两张排行表。
  - 底部：最近访问明细表（时间本地化显示、IP、城市 / 国家、来源）。
  - 一个“包含机器人”开关。
- 图表库：Chart.js（固定版本，从 cdnjs 加载）；数据全部由 `/stats` 返回，页面不含任何第三方追踪。
- 图表配色与现有站点的奶油/鼠尾草色系协调，同时适配浅色背景；确保色盲友好（不单靠红绿区分）。

## 8. 安全与隐私

- `STATS_KEY` 为 32 字节以上随机串，只存在 Worker secret 和站主浏览器的 localStorage 中；不写进仓库、不写进 `stats.html`。
- `/stats` 只读、只返回聚合与最近 200 条；错误口令统一返回 401，不泄露任何数据。
- 采集端点公开是设计使然；风险是被人刷数据。接受这个风险（个人站点），仅做请求体大小限制；如日后被刷，再加 Cloudflare WAF / 简单的每 IP 频控。
- 首页页脚加一句英文说明：
  `This site keeps anonymous visit statistics (IP address and approximate location) to understand its audience.`
- IP 最多保留 365 天，之后自动删除；不存储 UA、运营商或设备信息。

## 9. 部署（构建者执行，站主提供凭据）

站主只需要：有 Cloudflare 免费账号，创建一个 API token（权限：Account → Workers Scripts:Edit、D1:Edit、Account Settings:Read），并提供 Account ID。

构建者用 `npx wrangler` 完成：

1. 校验凭据：`npx wrangler whoami`。
2. `npx wrangler d1 create visitor_stats`，把返回的 `database_id` 写入 `worker/wrangler.toml`。
3. `npx wrangler d1 execute visitor_stats --remote --file=worker/schema.sql`。
4. 生成 32 字节随机 `STATS_KEY`，`npx wrangler secret put STATS_KEY`；`ALLOWED_ORIGIN` 作为普通变量写进 `wrangler.toml`。
5. `npx wrangler deploy`，取得 `https://visitor-stats.<subdomain>.workers.dev`。
6. 用 curl 向 `/collect` 发一条测试请求，确认 D1 中有行；用 `/stats` 确认鉴权与聚合返回。
7. 把 Worker URL 写入 `index.html` 的采集脚本常量；提交并 push（push 前征得站主同意）。
8. 站主打开 `/stats.html`，输入 `STATS_KEY`。

清理任务：`wrangler.toml` 中配置每日 Cron（`0 3 * * *`），Worker 的 `scheduled` handler 删除 365 天前的行。

凭据处理：token 只作为环境变量 `CLOUDFLARE_API_TOKEN` 传入；不写进 shell 历史、不写进任何文件、不提交。部署完成后提醒站主吊销或轮换。

仓库内交付物：
```
worker/worker.js        Worker 全部逻辑（collect / stats / cleanup）
worker/schema.sql       D1 建表语句
worker/README.md        逐步部署说明（控制台路径为主，wrangler 为备选）
stats.html              查看面板
index.html              末尾加采集脚本 + 页脚隐私说明
```

## 10. 交给构建者决定的部分

- bot 关键字清单的具体内容。
- `stats.html` 的具体视觉细节与图表实现方式（在 Chart.js 与手写 SVG 间取舍）。
- 是否额外展示每日独立访客等次要指标。
- 部署说明的措辞与截图（如有必要）。
- 本地联调方式（`wrangler dev` 或最小 mock）。

## 11. 验收标准

- 部署后先用 curl、再用真实浏览器各验证一次：D1 中出现一条含正确 IP / 城市 / 来源的记录。
- 打开 `stats.html`，无口令或错口令时看不到任何数据；正确口令下能看到图表与明细。
- 手机窄屏打开面板不横向溢出。
- 页面加载未因采集脚本报错或明显变慢；被广告拦截器拦截时页面功能不受影响。
- 连续访问 10 次，免费额度消耗可忽略；一年内数据量远低于 D1 免费上限。
