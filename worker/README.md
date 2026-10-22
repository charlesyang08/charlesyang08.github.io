# Visitor Stats Worker

这个 Worker 给 `charlesyang08.github.io` 提供免费的访问统计：
接收首页发来的采集请求，把访问写入 Cloudflare D1，并给 `stats.html` 提供带密钥的聚合接口。

## 记录什么

只记录：时间（UTC）、IP、国家、城市、来源页、是否机器人。

不记录：User-Agent、运营商 / ASN、设备、屏幕、语言、访问路径。UA 只在 Worker 内存里用于判断 `is_bot`，不会写库。
明细保留 365 天，每天 03:00 UTC 由 Cron 自动删除旧行。

## 文件

| 文件 | 作用 |
| --- | --- |
| `src/index.js` | Worker 入口：路由、CORS、每日清理 |
| `src/collect.js` | `POST /collect`：读取 IP / 地理信息并写库 |
| `src/stats.js` | `GET /stats`：鉴权与聚合查询 |
| `src/lib.js` | bot 判断、来源归一化、密钥比较、CORS 头 |
| `schema.sql` | D1 建表语句 |
| `wrangler.toml` | Worker 配置、D1 绑定、Cron |

## 本地开发

```bash
printf 'STATS_KEY=local-test-key\n' > worker/.dev.vars
npx wrangler d1 execute visitor_stats --local --config worker/wrangler.toml --file worker/schema.sql
npx wrangler dev --config worker/wrangler.toml --port 8787
```

另开终端验证：

```bash
curl -i -X POST http://127.0.0.1:8787/collect \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36' \
  -d '{"referrer":"https://example.com/x"}'

curl -s 'http://127.0.0.1:8787/stats?days=7' -H 'Authorization: Bearer local-test-key'
```

`worker/.dev.vars` 只放本地测试密钥，已被 `.gitignore` 忽略。

## 首次部署

前置：Cloudflare 免费账号、一个权限最小的 API token（Workers Scripts:Edit、D1:Edit、Account Settings:Read）、Account ID。

```bash
set -a; . /path/to/cloudflare.env; set +a   # 提供 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID

npx wrangler whoami --config worker/wrangler.toml
npx wrangler d1 create visitor_stats --config worker/wrangler.toml
# 把输出的 database_id 写进 worker/wrangler.toml

npx wrangler d1 execute visitor_stats --remote --config worker/wrangler.toml --file worker/schema.sql
npx wrangler secret put STATS_KEY --config worker/wrangler.toml
npx wrangler deploy --config worker/wrangler.toml
```

部署成功后，把 Worker URL 填到两处：

- `index.html` 里采集脚本的 `ENDPOINT`（以 `/collect` 结尾）
- `assets/stats-app.js` 里的 `STATS_ENDPOINT`（以 `/stats` 结尾）

然后访问 `https://charlesyang08.github.io/stats.html`，输入 `STATS_KEY`。

## 日常维护

重新部署：

```bash
npx wrangler deploy --config worker/wrangler.toml
```

查看实时日志：

```bash
npx wrangler tail --config worker/wrangler.toml
```

轮换密钥：

```bash
npx wrangler secret put STATS_KEY --config worker/wrangler.toml
```

设置新值后，在 `stats.html` 点 `Sign out`，再输入新密钥。旧的密钥立即失效。

## 免费额度

- Workers Free：每天 100,000 次请求
- D1 Free：5 GB 存储、每天 500 万行读、10 万行写

一次访问大约消耗 1 次 Worker 请求和 1 行写入，个人作品集远低于上限。

## 安全

- `STATS_KEY` 只存在 Worker secret 和站主浏览器的 `localStorage`，不要写进仓库或截图。
- API token 只通过环境变量传入，不要提交；用完建议吊销。
- `/collect` 是公开端点，理论上可被刷数据；个人站点接受这个风险，请求体限制为 2 KB。
- `/stats` 没有密钥一律返回 401，不返回任何访问数据。
