# Visitor Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给静态甜品作品集加一个免费的访客统计系统：记录每次访问的时间、IP、国家、城市与来源，并提供一个带图表、需要密钥的桌面查看面板。

**Architecture:** `index.html` 末尾的小脚本把来源页 POST 到 Cloudflare Worker；Worker 从请求本身读取真实 IP 与 `request.cf` 的国家 / 城市并写入 D1；`stats.html`（GitHub Pages 上的静态页）用 Bearer 密钥调用 Worker 的 `/stats` 聚合接口并渲染图表。免费额度内运行，无需自定义域名。

**Tech Stack:** Cloudflare Workers（ES modules）、D1（SQLite）、Wrangler、Node.js 24 内置 `node:test`、原生 HTML/CSS/JS、Chart.js 4.4.7（cdnjs）。

**Spec:** `docs/superpowers/specs/2026-10-22-visitor-analytics-design.md`

## Global Constraints

- **所有网页端交付物必须全英文，不得出现任何中文字符**：`index.html`、`stats.html`、`assets/stats-app.js`、`worker/src/*.js`、`worker/schema.sql`、`worker/wrangler.toml`。注释、UI 文案、错误信息都算。`worker/README.md` 与 `docs/` 下的文档可以用中文。
- 只记录六个字段：`ts`、`ip`、`country`、`city`、`referrer`、`is_bot`。**不记录也不展示 User-Agent、运营商 / ASN、设备、屏幕、语言、访问路径。** UA 只允许在 Worker 内存中用于判断 `is_bot`，绝不写库。
- 只用免费额度：Workers Free（10 万请求/天）、D1 Free（5GB、500 万读/天、10 万写/天）；不引入自定义域名、不引入付费服务。
- D1 绑定名固定为 `DB`；环境变量 `ALLOWED_ORIGIN=https://charlesyang08.github.io`；密钥变量名 `STATS_KEY`。
- 时间存 UTC ISO 字符串；"一天"按 Asia/Shanghai（UTC+8）分桶，SQL 用 `date(ts, '+8 hours')`。
- 独立访客按 `COUNT(DISTINCT ip)` 估算。
- 明细保留 365 天，由每日 Cron 删除旧行。
- 采集端点必须永不向页面抛错：任何失败都返回 `204`。
- 不提交任何密钥：`.gitignore` 必须覆盖 `.wrangler/`、`node_modules/`、`.dev.vars`、`worker/.dev.vars`。
- 不改动 GitHub Pages 的托管方式，不新增构建步骤。

## Review Focus

1. **广告拦截器或网络失败挡住 `/collect`** → 页面照常工作，控制台不出现未捕获错误。由 Task 2 的 DB 抛错测试与 Task 5 的 `catch` 结构覆盖。
2. **国家 / 城市缺失**（VPN、本地开发、卫星网络）→ 行照样插入，空字段为 `null`，面板显示 `Unknown` 而不是崩溃。由 Task 2 的 null-cf 测试覆盖。
3. **超长或畸形的 referrer** → 截断到 255 字符或归一为 `(direct)`，仍然返回 204。由 Task 2 的截断测试覆盖。
4. **错误、空或缺失的密钥** → 401 且不返回任何数据；即使 `STATS_KEY` 未配置也是 401。由 Task 3 的鉴权测试覆盖。
5. **D1 不可用或超额** → `/collect` 仍 204；`/stats` 返回 500 `{ "error": "server error" }`，面板显示错误提示而不是假装成功。由 Task 2、Task 3、Task 6 的测试覆盖。
6. **隐私边界被悄悄突破**（有人后来把 UA 或设备写回库里）→ 行结构测试固定为 6 个字段；英文守卫之外再加一条“SQL 不出现 ua / asn / screen”的检查。由 Task 2 与 Task 3 测试覆盖。

---

### Task 1: 脚手架与共享纯函数

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `worker/wrangler.toml`
- Create: `worker/schema.sql`
- Create: `worker/src/lib.js`
- Test: `tests/lib.test.js`

**Interfaces:**
- Produces:
  - `isBot(ua: string): boolean`
  - `normalizeReferrer(ref: string, selfHost: string): string`（返回 hostname 或 `'(direct)'`）
  - `safeEqual(a: unknown, b: unknown): boolean`
  - `corsHeaders(origin: string | null, allowedOrigin: string): Record<string, string>`

- [ ] **Step 0: 建 `package.json` 并安装 Wrangler**

```json
{
  "name": "charlesyang08-visitor-stats",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test",
    "dev": "wrangler dev --config worker/wrangler.toml",
    "deploy": "wrangler deploy --config worker/wrangler.toml"
  }
}
```

```bash
npm install --save-dev wrangler
```
Expected: 生成 `package-lock.json` 与 `node_modules/`，`npm test` 可以运行。

- [ ] **Step 1: 写失败测试 `tests/lib.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { isBot, normalizeReferrer, safeEqual, corsHeaders } from '../worker/src/lib.js';

test('isBot detects crawlers but not curl', () => {
  assert.equal(isBot('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36'), false);
  assert.equal(isBot('Googlebot/2.1 (+http://www.google.com/bot.html)'), true);
  assert.equal(isBot('HeadlessChrome/120.0'), true);
  assert.equal(isBot('curl/8.4.0'), false);
  assert.equal(isBot(''), true);
});

test('normalizeReferrer reduces to hostname and treats self as direct', () => {
  assert.equal(normalizeReferrer('', 'charlesyang08.github.io'), '(direct)');
  assert.equal(normalizeReferrer('https://charlesyang08.github.io/index.html', 'charlesyang08.github.io'), '(direct)');
  assert.equal(normalizeReferrer('https://www.google.com/search?q=dessert', 'charlesyang08.github.io'), 'www.google.com');
  assert.equal(normalizeReferrer('not a url', 'charlesyang08.github.io'), '(direct)');
});

test('safeEqual handles length and type differences', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual(null, 'abc'), false);
  assert.equal(safeEqual('abc', undefined), false);
});

test('corsHeaders allows the site origin and localhost only', () => {
  const site = corsHeaders('https://charlesyang08.github.io', 'https://charlesyang08.github.io');
  assert.equal(site['Access-Control-Allow-Origin'], 'https://charlesyang08.github.io');
  assert.equal(site['Access-Control-Allow-Headers'], 'Content-Type, Authorization');
  assert.equal(site['Vary'], 'Origin');
  assert.equal(
    corsHeaders('http://localhost:8787', 'https://charlesyang08.github.io')['Access-Control-Allow-Origin'],
    'http://localhost:8787'
  );
  assert.deepEqual(corsHeaders('https://evil.example', 'https://charlesyang08.github.io'), {});
  assert.deepEqual(corsHeaders(null, 'https://charlesyang08.github.io'), {});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '../worker/src/lib.js'`。

- [ ] **Step 3: 写 `.gitignore`、Worker 配置与建表语句**

`.gitignore`：
```
node_modules/
.wrangler/
.dev.vars
worker/.dev.vars
```

`worker/wrangler.toml`（`database_id` 是占位 UUID，Task 8 创建 D1 后替换）：
```toml
name = "visitor-stats"
main = "src/index.js"
compatibility_date = "2026-10-01"

[vars]
ALLOWED_ORIGIN = "https://charlesyang08.github.io"

[[d1_databases]]
binding = "DB"
database_name = "visitor_stats"
database_id = "00000000-0000-0000-0000-000000000000"

[triggers]
crons = ["0 3 * * *"]
```

`worker/schema.sql`：
```sql
CREATE TABLE IF NOT EXISTS visits (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT    NOT NULL,
  ip        TEXT    NOT NULL,
  country   TEXT,
  city      TEXT,
  referrer  TEXT,
  is_bot    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits(ts);
CREATE INDEX IF NOT EXISTS idx_visits_country ON visits(country);
CREATE INDEX IF NOT EXISTS idx_visits_referrer ON visits(referrer);
```

- [ ] **Step 4: 实现 `worker/src/lib.js`**

```js
const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|bingpreview|facebookexternalhit|embedly|telegrambot|whatsapp|discordbot/i;
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function isBot(ua) {
  if (!ua) return true;
  return BOT_RE.test(ua);
}

export function normalizeReferrer(ref, selfHost) {
  if (!ref) return '(direct)';
  try {
    const url = new URL(ref);
    if (!url.hostname || url.hostname === selfHost) return '(direct)';
    return url.hostname;
  } catch {
    return '(direct)';
  }
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function corsHeaders(origin, allowedOrigin) {
  if (!origin) return {};
  if (origin !== allowedOrigin && !LOCAL_ORIGIN_RE.test(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS，4 个测试全部通过。

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json .gitignore worker/wrangler.toml worker/schema.sql worker/src/lib.js tests/lib.test.js docs/superpowers/specs docs/superpowers/plans
git commit -m "chore: scaffold visitor analytics worker and shared helpers"
```

---

### Task 2: 访问记录与采集接口

**Files:**
- Create: `worker/src/collect.js`
- Create: `tests/helpers.js`
- Test: `tests/collect.test.js`

**Interfaces:**
- Consumes: `isBot`, `normalizeReferrer` from `worker/src/lib.js`。
- Produces:
  - `buildVisitRow(input: { headers: Headers, cf: object, body: object, ip: string, now: Date }): unknown[]`，返回 6 个值：`[ts, ip, country, city, referrer, is_bot]`。
  - `handleCollect(request: Request, env: { DB: D1Database }, cf: object, now?: Date): Promise<Response>`，恒返回 204。

- [ ] **Step 1: 写测试辅助 `tests/helpers.js`**

```js
export function mockDb(resolve = () => []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const state = { sql, args: [] };
      const stmt = {
        bind(...args) {
          state.args = args;
          return stmt;
        },
        async run() {
          calls.push({ ...state, kind: 'run' });
          return { success: true, meta: { changes: 1 } };
        },
        async all() {
          calls.push({ ...state, kind: 'all' });
          return { results: resolve(sql, state.args), success: true, meta: {} };
        },
        async first() {
          calls.push({ ...state, kind: 'first' });
          const rows = resolve(sql, state.args);
          return Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null);
        },
      };
      return stmt;
    },
  };
}

export function jsonRequest(url, body, { method = 'POST', headers = {}, ...rest } = {}) {
  return new Request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...rest,
  });
}
```

- [ ] **Step 2: 写失败测试 `tests/collect.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVisitRow, handleCollect } from '../worker/src/collect.js';
import { mockDb, jsonRequest } from './helpers.js';

const NOW = new Date('2026-10-22T08:15:03.120Z');
const CF = { country: 'JP', city: 'Tokyo' };
const ENV = { ALLOWED_ORIGIN: 'https://charlesyang08.github.io' };

test('buildVisitRow stores only ts, ip, country, city, referrer, is_bot', () => {
  const row = buildVisitRow({
    headers: new Headers({ 'User-Agent': 'Mozilla/5.0 Chrome/120.0' }),
    cf: CF,
    body: { referrer: 'https://www.google.com/search?q=x' },
    ip: '203.0.113.9',
    now: NOW,
  });
  assert.deepEqual(row, ['2026-10-22T08:15:03.120Z', '203.0.113.9', 'JP', 'Tokyo', 'www.google.com', 0]);
});

test('buildVisitRow tolerates missing geo, self referrer, bots, and long referrers', () => {
  const row = buildVisitRow({
    headers: new Headers({ 'User-Agent': 'Googlebot/2.1' }),
    cf: {},
    body: { referrer: 'https://charlesyang08.github.io/' },
    ip: '',
    now: NOW,
  });
  assert.deepEqual(row.slice(2, 4), [null, null]);
  assert.equal(row[1], 'unknown');
  assert.equal(row[4], '(direct)');
  assert.equal(row[5], 1);

  const longRow = buildVisitRow({
    headers: new Headers({ 'User-Agent': 'Mozilla/5.0 Chrome/120.0' }),
    cf: {},
    body: { referrer: 'https://' + 'a'.repeat(400) + '.com/x' },
    ip: '203.0.113.9',
    now: NOW,
  });
  assert.equal(longRow[4].length, 255);
});

test('handleCollect inserts a visit and returns 204', async () => {
  const db = mockDb();
  const req = jsonRequest(
    'https://w.dev/collect',
    { referrer: '' },
    { headers: { 'CF-Connecting-IP': '203.0.113.9' } }
  );
  const res = await handleCollect(req, { ...ENV, DB: db }, CF, NOW);
  assert.equal(res.status, 204);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /INSERT INTO visits/);
  assert.equal(db.calls[0].args.length, 6);
  assert.equal(db.calls[0].args[1], '203.0.113.9');
  assert.equal(db.calls[0].args[4], '(direct)');
  assert.equal(db.calls[0].args[5], 0);
});

test('handleCollect flags bots without storing the UA', async () => {
  const db = mockDb();
  const req = jsonRequest('https://w.dev/collect', {}, { headers: { 'User-Agent': 'Googlebot/2.1' } });
  await handleCollect(req, { ...ENV, DB: db }, CF, NOW);
  assert.equal(db.calls[0].args[5], 1);
  assert.equal(db.calls[0].args.length, 6);
  assert.doesNotMatch(db.calls[0].sql, /ua/i);
});

test('handleCollect is inert for oversized or malformed bodies', async () => {
  const db = mockDb();
  const big = await handleCollect(
    jsonRequest('https://w.dev/collect', '{"referrer":"' + 'x'.repeat(4000) + '"}'),
    { ...ENV, DB: db },
    CF,
    NOW
  );
  assert.equal(big.status, 204);
  assert.equal(db.calls.length, 0);

  const malformed = await handleCollect(jsonRequest('https://w.dev/collect', '{'), { ...ENV, DB: db }, CF, NOW);
  assert.equal(malformed.status, 204);
  assert.equal(db.calls.length, 0);
});

test('handleCollect still returns 204 when D1 fails', async () => {
  const db = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async run() {
          throw new Error('D1 down');
        },
      };
    },
  };
  const res = await handleCollect(jsonRequest('https://w.dev/collect', {}), { ...ENV, DB: db }, CF, NOW);
  assert.equal(res.status, 204);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test`
Expected: FAIL，找不到 `worker/src/collect.js`。

- [ ] **Step 4: 实现 `worker/src/collect.js`**

要点：
- 列顺序严格为 `[ts, ip, country, city, referrer, is_bot]`。
- `ip` 取 `CF-Connecting-IP`，缺失时用 `'unknown'`。
- `country` / `city` 取 `cf.country` / `cf.city`，缺失为 `null`。
- `referrer` 用 `normalizeReferrer(body.referrer, 'charlesyang08.github.io')`，再 `slice(0, 255)`。
- `is_bot` 用 `isBot(headers.get('User-Agent'))`；UA 不进入返回值。
- `handleCollect` 先 `request.text()`，长度 > 2048 直接 204；`JSON.parse` 失败也 204；`env.DB.prepare(...).bind(...).run()` 外层 `try/catch` 吞掉所有异常。
- INSERT 写成 `INSERT INTO visits (ts, ip, country, city, referrer, is_bot) VALUES (?,?,?,?,?,?)`，6 个占位符。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add worker/src/collect.js tests/helpers.js tests/collect.test.js
git commit -m "feat: record visits with IP, country, city, and source"
```

---

### Task 3: 聚合查询与统计接口

**Files:**
- Create: `worker/src/stats.js`
- Test: `tests/stats.test.js`

**Interfaces:**
- Consumes: `safeEqual` from `worker/src/lib.js`。
- Produces:
  - `buildRange(now: Date, days: number): { startIso: string, dates: string[] }`
  - `parseDays(raw: string | null): number`（默认 30，夹在 1–365）
  - `fillDaily(dates: string[], rows: Array<{ day: string, visits: number, uniques: number }>): Array<{ date: string, visits: number, uniques: number }>`
  - `getStats(db, { days: number, includeBots: boolean, now: Date }): Promise<object>`，返回键：`range`、`totals`、`daily`、`top_referrers`、`top_countries`、`top_cities`、`recent`。
  - `handleStats(request: Request, env: { DB: D1Database, STATS_KEY?: string }): Promise<Response>`

- [ ] **Step 1: 写失败测试 `tests/stats.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRange, parseDays, fillDaily, getStats, handleStats } from '../worker/src/stats.js';
import { mockDb } from './helpers.js';

const NOW = new Date('2026-10-22T17:30:00.000Z');

function resolveStats(sql) {
  if (/GROUP BY day/.test(sql)) return [{ day: '2026-10-22', visits: 3, uniques: 2 }];
  if (/GROUP BY referrer/.test(sql)) return [{ referrer: '(direct)', visits: 5 }];
  if (/GROUP BY country/.test(sql)) return [{ country: 'JP', visits: 3 }];
  if (/GROUP BY city/.test(sql)) return [{ city: 'Tokyo', country: 'JP', visits: 2 }];
  if (/ORDER BY ts DESC/.test(sql))
    return [{ ts: '2026-10-22T10:00:00.000Z', ip: '203.0.113.9', country: 'JP', city: 'Tokyo', referrer: '(direct)' }];
  if (/AS bots/.test(sql)) return [{ bots: 2 }];
  if (/AS visits/.test(sql)) return [{ visits: 12, uniques: 9, countries: 3, referrers: 4 }];
  return [];
}

test('buildRange buckets days in Asia/Shanghai', () => {
  const range = buildRange(NOW, 3);
  assert.equal(range.startIso, '2026-10-21T16:00:00.000Z');
  assert.deepEqual(range.dates, ['2026-10-21', '2026-10-22', '2026-10-23']);
});

test('parseDays defaults and clamps', () => {
  assert.equal(parseDays(null), 30);
  assert.equal(parseDays('7'), 7);
  assert.equal(parseDays('0'), 1);
  assert.equal(parseDays('999'), 365);
  assert.equal(parseDays('abc'), 30);
});

test('fillDaily inserts zero rows for missing days', () => {
  assert.deepEqual(fillDaily(['2026-10-21', '2026-10-22'], [{ day: '2026-10-22', visits: 3, uniques: 2 }]), [
    { date: '2026-10-21', visits: 0, uniques: 0 },
    { date: '2026-10-22', visits: 3, uniques: 2 },
  ]);
});

test('getStats filters bots, buckets by Shanghai day, and fills the series', async () => {
  const db = mockDb(resolveStats);
  const data = await getStats(db, { days: 3, includeBots: false, now: NOW });

  assert.equal(data.range.timezone, 'Asia/Shanghai');
  assert.equal(data.range.include_bots, false);
  assert.deepEqual(data.totals, { visits: 12, uniques: 9, bots: 2, countries: 3, referrers: 4 });
  assert.equal(data.daily.length, 3);
  assert.deepEqual(data.daily[2], { date: '2026-10-23', visits: 0, uniques: 0 });

  const dailyCall = db.calls.find((c) => /GROUP BY day/.test(c.sql));
  assert.match(dailyCall.sql, /date\(ts, '\+8 hours'\)/);
  assert.match(dailyCall.sql, /COUNT\(DISTINCT ip\)/);
  assert.match(dailyCall.sql, /is_bot = 0/);
  assert.equal(dailyCall.args[0], '2026-10-21T16:00:00.000Z');
});

test('getStats includes bots when asked', async () => {
  const db = mockDb(resolveStats);
  await getStats(db, { days: 7, includeBots: true, now: NOW });
  const dailyCall = db.calls.find((c) => /GROUP BY day/.test(c.sql));
  assert.doesNotMatch(dailyCall.sql, /is_bot = 0/);
});

test('stats SQL never selects UA, ASN, or device fields', async () => {
  const db = mockDb(resolveStats);
  await getStats(db, { days: 7, includeBots: false, now: NOW });
  for (const call of db.calls) {
    assert.doesNotMatch(call.sql, /\b(ua|asn|as_org|screen|lang)\b/i);
  }
});

test('handleStats rejects missing, empty, and wrong keys', async () => {
  const env = { DB: mockDb(resolveStats), STATS_KEY: 'good-key' };
  for (const headers of [{}, { Authorization: '' }, { Authorization: 'Bearer ' }, { Authorization: 'Bearer nope' }]) {
    const res = await handleStats(new Request('https://w.dev/stats', { headers }), env);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
  const noKey = await handleStats(new Request('https://w.dev/stats', { headers: { Authorization: 'Bearer x' } }), {
    DB: mockDb(resolveStats),
  });
  assert.equal(noKey.status, 401);
});

test('handleStats returns aggregates for a valid key', async () => {
  const res = await handleStats(
    new Request('https://w.dev/stats?days=7&bots=1', { headers: { Authorization: 'Bearer good-key' } }),
    { DB: mockDb(resolveStats), STATS_KEY: 'good-key' }
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const data = await res.json();
  assert.equal(data.range.days, 7);
  assert.equal(data.range.include_bots, true);
  assert.deepEqual(data.top_countries, [{ country: 'JP', visits: 3 }]);
  assert.equal(data.recent[0].ip, '203.0.113.9');
  assert.deepEqual(Object.keys(data.recent[0]).sort(), ['city', 'country', 'ip', 'referrer', 'ts']);
});

test('handleStats returns 500 without data when D1 fails', async () => {
  const db = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async all() {
          throw new Error('D1 down');
        },
        async first() {
          throw new Error('D1 down');
        },
      };
    },
  };
  const res = await handleStats(new Request('https://w.dev/stats', { headers: { Authorization: 'Bearer good-key' } }), {
    DB: db,
    STATS_KEY: 'good-key',
  });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'server error' });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL，找不到 `worker/src/stats.js`。

- [ ] **Step 3: 实现 `worker/src/stats.js`**

要点：
- `buildRange` 用固定的 +8 小时偏移（Asia/Shanghai 无夏令时）计算起始 UTC 时刻与日期键。
- `getStats` 用 `Promise.all` 并发执行 7 条查询：
  - totals：`SELECT COUNT(*) AS visits, COUNT(DISTINCT ip) AS uniques, COUNT(DISTINCT country) AS countries, COUNT(DISTINCT referrer) AS referrers FROM visits WHERE ts >= ?` + 条件 `AND is_bot = 0`；输出 `{ visits, uniques, countries, referrers }`
  - bots：`SELECT COUNT(*) AS bots FROM visits WHERE ts >= ? AND is_bot = 1`（始终查询）
  - daily：`SELECT date(ts, '+8 hours') AS day, COUNT(*) AS visits, COUNT(DISTINCT ip) AS uniques ... GROUP BY day ORDER BY day`
  - referrers / countries / cities（含 `country`）：各 `GROUP BY ... ORDER BY visits DESC LIMIT 10`
  - recent：`SELECT ts, ip, country, city, referrer FROM visits WHERE ts >= ? ... ORDER BY ts DESC LIMIT 200`
- 所有 `.all()` 取 `.results`；`.first()` 用 `?? { visits: 0, uniques: 0, countries: 0, referrers: 0 }` 兜底。
- `handleStats`：
  - 从 `Authorization` 解析 Bearer；`env.STATS_KEY` 缺失或 `safeEqual` 失败 → 401 `{"error":"unauthorized"}`。
  - `days = parseDays(url.searchParams.get('days'))`；`includeBots = url.searchParams.get('bots') === '1'`。
  - 成功 → 200 JSON，`Cache-Control: no-store`。
  - 任何 D1 异常 → 500 `{"error":"server error"}`，不包含任何访问数据。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add worker/src/stats.js tests/stats.test.js
git commit -m "feat: aggregate visits with authenticated stats endpoint"
```

---

### Task 4: Worker 入口、CORS 与清理任务

**Files:**
- Create: `worker/src/index.js`
- Test: `tests/index.test.js`

**Interfaces:**
- Consumes: `handleCollect`、`handleStats`、`corsHeaders`。
- Produces: default export `{ fetch(request, env, ctx), scheduled(controller, env, ctx) }`。

- [ ] **Step 1: 写失败测试 `tests/index.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';
import { mockDb, jsonRequest } from './helpers.js';

const ORIGIN = 'https://charlesyang08.github.io';

function env() {
  return { DB: mockDb(), STATS_KEY: 'good-key', ALLOWED_ORIGIN: ORIGIN };
}

test('OPTIONS preflight returns 204 with CORS for the site origin', async () => {
  const res = await worker.fetch(
    new Request('https://w.dev/collect', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
    }),
    env()
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(res.headers.get('Access-Control-Allow-Headers'), 'Content-Type, Authorization');
});

test('collect and stats responses carry CORS headers', async () => {
  const e = env();
  const collected = await worker.fetch(
    jsonRequest('https://w.dev/collect', {}, { headers: { Origin: ORIGIN } }),
    e,
    {}
  );
  assert.equal(collected.status, 204);
  assert.equal(collected.headers.get('Access-Control-Allow-Origin'), ORIGIN);

  const unauthorized = await worker.fetch(
    new Request('https://w.dev/stats', { headers: { Origin: ORIGIN } }),
    e
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('disallowed origins get no CORS headers', async () => {
  const res = await worker.fetch(
    jsonRequest('https://w.dev/collect', {}, { headers: { Origin: 'https://evil.example' } }),
    env(),
    {}
  );
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});

test('unknown routes and methods return 404', async () => {
  assert.equal((await worker.fetch(new Request('https://w.dev/nope'), env())).status, 404);
  assert.equal((await worker.fetch(new Request('https://w.dev/collect'), env())).status, 404);
  assert.equal((await worker.fetch(new Request('https://w.dev/stats', { method: 'POST' }), env())).status, 404);
});

test('scheduled deletes rows older than 365 days', async () => {
  const db = mockDb();
  await worker.scheduled({}, { DB: db });
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /DELETE FROM visits WHERE ts < \?/);
  const cutoff = new Date(db.calls[0].args[0]).getTime();
  assert.ok(Math.abs(Date.now() - cutoff - 365 * 86400000) < 5000);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL，找不到 `worker/src/index.js`。

- [ ] **Step 3: 实现 `worker/src/index.js`**

要点：
- `fetch` 先算 `corsHeaders(request.headers.get('Origin'), env.ALLOWED_ORIGIN)`。
- `OPTIONS` 直接返回 204。
- `POST /collect` → `handleCollect(request, env, request.cf ?? {})`。
- `GET /stats` → `handleStats(request, env)`。
- 其他 → 404 `Not found`。
- 把 CORS 头合并到最终响应：用 `new Headers(res.headers)`，逐个 `set`，再 `new Response(res.body, { status, headers })`。
- `scheduled`：`const cutoff = new Date(Date.now() - 365 * 86400000).toISOString(); await env.DB.prepare('DELETE FROM visits WHERE ts < ?').bind(cutoff).run();`

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS，全部测试通过。

- [ ] **Step 5: 提交**

```bash
git add worker/src/index.js tests/index.test.js
git commit -m "feat: route worker requests and schedule retention cleanup"
```

---

### Task 5: 首页采集脚本与页脚隐私说明

**Files:**
- Modify: `index.html`（`</body>` 前约 540 行；页脚 `.meta` 内约 536 行；样式表约 221–224 行）
- Test: `tests/site.test.js`

**Interfaces:**
- Produces: `<script id="visit-beacon">`，端点常量 `ENDPOINT` 在 Task 8 被替换为真实 Worker URL。

- [ ] **Step 1: 写失败测试 `tests/site.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('beacon sends only the referrer and never blocks the page', () => {
  assert.match(html, /<script id="visit-beacon">/);
  assert.match(html, /keepalive:\s*true/);
  assert.match(html, /document\.referrer/);
  assert.match(html, /\.catch\(function \(\) \{\}\)/);

  const start = html.indexOf('<script id="visit-beacon">');
  const beacon = html.slice(start, html.indexOf('</script>', start));
  assert.doesNotMatch(beacon, /screen\.width|navigator\.language|location\.pathname/);
});

test('privacy note appears inside the footer', () => {
  const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
  assert.match(footer, /This site keeps anonymous visit statistics \(IP address and approximate location\) to understand its audience\./);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL，`visit-beacon` 与隐私说明不存在。

- [ ] **Step 3: 清除 `index.html` 里唯一的中文，并在 `</body>` 前插入采集脚本**

`index.html` 第 13 行的注释里有一个中文文件夹名（`D:\Dessert\...\`）。英文守卫会扫描整个文件，所以把它改成英文描述，信息不丢失：

```html
  • Photos live in:   D:\Dessert\Baking2\hongbei\   and
                      D:\Dessert\<baking diary folder>\
    The second folder's name is written in Chinese; it holds pies, cakes, and whipped cream.
```

然后在 `</body>` 前插入采集脚本：

```html
<script id="visit-beacon">
(function () {
  var ENDPOINT = 'https://visitor-stats.example.workers.dev/collect';
  try {
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referrer: document.referrer }),
      keepalive: true
    }).catch(function () {});
  } catch (e) {}
})();
</script>
```

- [ ] **Step 4: 在页脚 `.meta` 内加隐私说明**

在 `Made by hand. Lower in sugar. Free of recipes.` 那一行之后加：

```html
<div class="privacy-note" style="margin-top:10px">This site keeps anonymous visit statistics (IP address and approximate location) to understand its audience.</div>
```

并在 `footer .meta b` 规则之后加样式（English-only，无中文）：

```css
footer .privacy-note{font-size:10px;letter-spacing:.04em;text-transform:none;color:var(--muted);opacity:.8}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add index.html tests/site.test.js
git commit -m "feat: add visit beacon and footer privacy note"
```

---

### Task 6: 查看面板

**Files:**
- Create: `stats.html`
- Create: `assets/stats-app.js`
- Test: `tests/dashboard.test.js`

**Interfaces:**
- Consumes: `GET /stats` 的响应结构（见 Task 3）。
- Produces（`assets/stats-app.js` 的导出，供测试与页面使用）：
  - `STORAGE_KEY = 'visitor_stats_key'`
  - `formatCountry(code: string | null): string`
  - `formatCount(n: number): string`
  - `formatDayLabel(date: string): string`
  - `buildStatsUrl(base: string, days: number, includeBots: boolean): string`
  - `errorMessage(status: number): string`
  - `init(): void`

- [ ] **Step 1: 写失败测试 `tests/dashboard.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCountry,
  formatCount,
  formatDayLabel,
  buildStatsUrl,
  errorMessage,
} from '../assets/stats-app.js';

test('formatCountry falls back safely', () => {
  assert.match(formatCountry('CN'), /China/i);
  assert.equal(formatCountry(null), 'Unknown');
  assert.equal(formatCountry('ZZ'), 'ZZ');
});

test('formatCount and formatDayLabel are stable', () => {
  assert.equal(formatCount(1234), '1,234');
  assert.equal(formatDayLabel('2026-10-22'), '10-22');
});

test('buildStatsUrl includes days and bots flag', () => {
  assert.equal(buildStatsUrl('https://w.dev/stats', 30, false), 'https://w.dev/stats?days=30');
  assert.equal(buildStatsUrl('https://w.dev/stats', 7, true), 'https://w.dev/stats?days=7&bots=1');
});

test('errorMessage explains auth and network failures', () => {
  assert.equal(errorMessage(401), 'That key did not work.');
  assert.equal(errorMessage(0), 'Could not load data. Check your connection and try again.');
  assert.equal(errorMessage(500), 'The server had a problem. Try again in a moment.');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL，找不到 `assets/stats-app.js`。

- [ ] **Step 3: 实现 `assets/stats-app.js`**

要点：
- 纯函数不触碰 DOM；所有 DOM 操作放在 `init()` 内。文件底部：
  ```js
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
  ```
- `formatCountry`：`new Intl.DisplayNames(['en'], { type: 'region' })`；异常或 `'Unknown Region'` 时返回原码；`null` → `Unknown`。
- `formatCount`：`Number(n || 0).toLocaleString('en-US')`。
- `formatDayLabel`：取 `YYYY-MM-DD` 的后 5 位。
- `buildStatsUrl`：`?days=N`，`includeBots` 时追加 `&bots=1`。
- `errorMessage(status)`：401 → `That key did not work.`；0（网络异常）→ `Could not load data. Check your connection and try again.`；其他 → `The server had a problem. Try again in a moment.`
- 端点常量：`export const STATS_ENDPOINT = 'https://visitor-stats.example.workers.dev/stats';`（Task 8 替换）。
- `init()` 行为：
  - 读取 `localStorage[STORAGE_KEY]`（包在 try/catch 里）。
  - 有 key → 直接 `load()`；返回 401 → 清除 key 并显示 gate；其他错误 → 显示错误条。
  - gate 表单提交 → 用输入值 `load()`；成功则写入 localStorage 并隐藏 gate；失败显示 `errorMessage(status)`。
  - `load()` 请求 `buildStatsUrl(STATS_ENDPOINT, days, includeBots)`，带 `Authorization: Bearer <key>`；设置 `#status` 为加载中；成功后渲染。
  - 渲染：4 个数字卡（`totals.visits`、`totals.uniques`、`totals.countries`、`totals.referrers`）；`#daily-chart` 折线图（visits 与 uniques 两条线）；`#referrer-chart` 横向条形图；国家、城市、最近访问三个表。
  - 最近访问表列：`Time`、`IP`、`Location`、`Source`。时间用 `new Date(ts).toLocaleString()`；地点用 `formatCountry`，有城市时显示 `City, Country`；来源直接显示 `referrer`。
  - Chart.js 实例保存在模块变量里，重载前 `.destroy()`；颜色：visits `#7C9773`、uniques `#E2A98F`、网格 `#E1E5DA`、文字 `#6E7770`；`maintainAspectRatio: false`。
  - 若 `typeof Chart === 'undefined'`（CDN 被拦截），跳过图表创建，表格照常渲染，并在 `#status` 显示 `Charts unavailable. Tables are still shown.`。
  - 空数据时显示 `No visits in this range yet.`；错误时保留上一次数据但在 `#status` 显示错误，不静默失败。
  - 范围按钮 `data-days="7|30|90"`、`#bots-toggle`、`#sign-out`（清 localStorage 并回到 gate）。

- [ ] **Step 4: 实现 `stats.html`（全英文）**

结构与文案：
- `<title>Visitor Log</title>`；引入 Chart.js：`<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.7/chart.umd.min.js"></script>`；`<script type="module" src="./assets/stats-app.js"></script>`。
- 配色沿用首页：`--cream:#FAF6EC; --paper:#FFFDF8; --ink:#26302A; --muted:#6E7770; --sage:#7C9773; --sage-deep:#4F684A; --clay:#E2A98F; --line:#E1E5DA;`。
- Gate：标题 `Visitor Log`、副标题 `A private view of who stops by.`、输入框 label `Access key`、按钮 `Open dashboard`、错误区 `#gate-error`。
- 主面板：标题 `Visitor Log`；范围按钮 `7 days` / `30 days` / `90 days`；开关 `Include bots`；按钮 `Sign out`。
- 数字卡：`Visits`、`Unique visitors`、`Countries`、`Referrers`。
- 图表区：`Visits over time`、`Top sources`。
- 表格：`Countries`（Country / Visits）、`Cities`（City / Country / Visits）、`Recent visits`（Time / IP / Location / Source）。
- 状态区：`#status` 带 `aria-live="polite"`；更新时间 `#updated`。
- 布局：max-width 1200px，两侧至少 16px；卡片 `repeat(4, 1fr)`，宽度 < 800px 时 2 列、< 520px 时 1 列；表格放在 `overflow-x:auto` 容器里；图表容器 `position:relative;height:280px`。
- 页面不得出现任何中文。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add stats.html assets/stats-app.js tests/dashboard.test.js
git commit -m "feat: add private chart dashboard for visit logs"
```

---

### Task 7: 英文约束守卫与本地联调

**Files:**
- Create: `tests/english.test.js`
- Create: `worker/README.md`（中文，说明文档，不受英文守卫约束）

**Interfaces:**
- Consumes: Task 1–6 的全部产物。

- [ ] **Step 1: 写英文守卫测试 `tests/english.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILES = [
  'index.html',
  'stats.html',
  'assets/stats-app.js',
  'worker/src/index.js',
  'worker/src/lib.js',
  'worker/src/collect.js',
  'worker/src/stats.js',
  'worker/schema.sql',
  'worker/wrangler.toml',
];
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

for (const file of FILES) {
  test(`no Chinese characters in ${file}`, () => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.equal(CJK.test(text), false, `${file} contains CJK characters`);
  });
}
```

- [ ] **Step 2: 运行测试**

Run: `npm test`
Expected: PASS。任何中文出现都会明确指出文件。

- [ ] **Step 3: 本地联调**

```bash
printf 'STATS_KEY=local-test-key\n' > worker/.dev.vars
npx wrangler d1 execute visitor_stats --local --config worker/wrangler.toml --file worker/schema.sql
npx wrangler dev --config worker/wrangler.toml --port 8787
```

另开一个终端：
```bash
curl -i -X POST http://127.0.0.1:8787/collect \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36' \
  -d '{"referrer":"https://example.com/x"}'
# Expected: HTTP/1.1 204

curl -s 'http://127.0.0.1:8787/stats?days=7' -H 'Authorization: Bearer local-test-key'
# Expected: JSON，totals.visits >= 1，recent 中包含 (direct) 或 example.com
```

- [ ] **Step 4: 写 `worker/README.md`（中文）**

覆盖：这个 Worker 做什么、文件职责、本地开发命令、重新部署命令、如何轮换 `STATS_KEY`、免费额度、数据保留 365 天、日志查看方式。明确写明：只记录 IP / 国家 / 城市 / 来源，不记录 UA 或设备；不要把 `STATS_KEY` 或 API token 写进仓库。

- [ ] **Step 5: 提交**

```bash
git add tests/english.test.js worker/README.md
git commit -m "test: guard English-only deliverables and document worker"
```

---

### Task 8: 部署与端到端验证

**Files:**
- Modify: `worker/wrangler.toml`（真实 `database_id`）
- Modify: `index.html`（真实 collect URL）
- Modify: `assets/stats-app.js`（真实 stats URL）
- Create（本地、不入库）: `C:\Users\james_yang\.cf-visitor-stats.env`、`C:\Users\james_yang\.visitor-stats-key`

**Interfaces:**
- Consumes: Task 1–7 的全部产物；站主提供的 Cloudflare API token 与 Account ID。

- [ ] **Step 1: 接收凭据（不入库、不回显）**

请站主创建 API token（Account → Workers Scripts:Edit、D1:Edit、Account Settings:Read），把两行写入仓库外的 `C:\Users\james_yang\.cf-visitor-stats.env`：
```
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
```
执行任何 wrangler 命令前：
```bash
set -a; . /c/Users/james_yang/.cf-visitor-stats.env; set +a
```
不要在输出中打印 token。

- [ ] **Step 2: 校验凭据**

```bash
npx wrangler whoami --config worker/wrangler.toml
```
Expected: 显示账号名与 Account ID，无鉴权错误。

- [ ] **Step 3: 创建 D1 并写入 database_id**

```bash
npx wrangler d1 create visitor_stats --config worker/wrangler.toml
```
把输出里的 `database_id` 写入 `worker/wrangler.toml` 替换占位 UUID。

- [ ] **Step 4: 建表**

```bash
npx wrangler d1 execute visitor_stats --remote --config worker/wrangler.toml --file worker/schema.sql
```
Expected: `executed successfully`。

- [ ] **Step 5: 生成并设置密钥**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```
把输出写入仓库外的 `C:\Users\james_yang\.visitor-stats-key`（仅站主可读），并：
```bash
printf '%s' "$(cat /c/Users/james_yang/.visitor-stats-key)" | npx wrangler secret put STATS_KEY --config worker/wrangler.toml
```
Expected: secret 创建成功。不要把这个值写进仓库、日志或对话。

- [ ] **Step 6: 部署**

```bash
npx wrangler deploy --config worker/wrangler.toml
```
Expected: 输出 `https://visitor-stats.<subdomain>.workers.dev`，并显示 cron trigger `0 3 * * *`。

- [ ] **Step 7: 把真实端点写回两个文件**

- `index.html`：把 `https://visitor-stats.example.workers.dev/collect` 换成真实 URL。
- `assets/stats-app.js`：把 `https://visitor-stats.example.workers.dev/stats` 换成真实 URL。

```bash
npm test
```
Expected: PASS。

- [ ] **Step 8: 用 curl 做端到端验证**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST 'https://<worker-host>/collect' \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36' \
  -d '{"referrer":""}'
# Expected: 204

curl -s 'https://<worker-host>/stats?days=1' -H "Authorization: Bearer $(cat /c/Users/james_yang/.visitor-stats-key)"
# Expected: JSON；totals.visits >= 1；recent[0].referrer == "(direct)"

curl -s -o /dev/null -w '%{http_code}\n' 'https://<worker-host>/stats?days=1'
# Expected: 401（无密钥时看不到任何数据）
```

- [ ] **Step 9: 提交并推送（推送前再次征得站主同意）**

```bash
git add worker/wrangler.toml index.html assets/stats-app.js docs/superpowers/specs docs/superpowers/plans
git commit -m "feat: connect visitor analytics endpoints and ship dashboard"
git push
```

Expected: GitHub Pages 构建完成（约 1 分钟）。

- [ ] **Step 10: 站主验收**

站主打开：
- `https://charlesyang08.github.io/`（确认页面正常、页脚说明存在）
- `https://charlesyang08.github.io/stats.html`（输入 `.visitor-stats-key` 中的密钥）

Expected：面板显示 curl 测试行和站主本次访问；无口令或错口令时看不到任何数据；手机窄屏不横向溢出。

- [ ] **Step 11: 清理凭据**

删除 `C:\Users\james_yang\.cf-visitor-stats.env`（API token），并提醒站主可在 Cloudflare 控制台吊销该 token。`worker/.dev.vars` 仅含本地测试密钥，保留即可；确认它已被 `.gitignore` 忽略。

---

## 验收标准（来自 Spec）

- [ ] 部署后 curl 与真实浏览器各产生一条含正确 IP / 国家 / 城市 / 来源的记录。
- [ ] 数据库中只有 6 个字段，没有 UA、运营商、设备、屏幕或语言。
- [ ] 无口令或错口令时 `stats.html` 不显示任何数据，且返回 401。
- [ ] 面板有：访问量趋势、来源 Top、国家 / 城市排行、最近明细；机器人默认过滤、可切换。
- [ ] 手机窄屏打开面板不横向溢出。
- [ ] 采集脚本失败（广告拦截、离线、D1 异常）时页面功能不受影响。
- [ ] 所有网页端交付物不含任何中文字符（`npm test` 中的英文守卫通过）。
- [ ] 免费额度：一次访问 = 1 次 Worker 请求 + 1 行 D1 写入，个人站点远低于上限。
