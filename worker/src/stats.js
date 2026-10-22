import { safeEqual } from './lib.js';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEZONE = 'Asia/Shanghai';

export function parseDays(raw) {
  if (raw === null || raw === undefined || raw === '') return 30;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return 30;
  return Math.min(365, Math.max(1, value));
}

export function buildRange(now, days) {
  const todayKey = new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
  const startOfTodayUtc = Date.parse(`${todayKey}T00:00:00.000Z`) - SHANGHAI_OFFSET_MS;
  const startMs = startOfTodayUtc - (days - 1) * DAY_MS;
  const dates = [];
  for (let i = 0; i < days; i += 1) {
    dates.push(new Date(startMs + i * DAY_MS + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10));
  }
  return { startIso: new Date(startMs).toISOString(), dates };
}

export function fillDaily(dates, rows) {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  return dates.map((date) => {
    const row = byDay.get(date);
    return { date, visits: row?.visits ?? 0, uniques: row?.uniques ?? 0 };
  });
}

export async function getStats(db, { days, includeBots, now }) {
  const { startIso, dates } = buildRange(now, days);
  const botClause = includeBots ? '' : ' AND is_bot = 0';

  const [totalsRow, botsRow, dailyRows, referrerRows, countryRows, cityRows, recentRows] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS visits, COUNT(DISTINCT ip) AS uniques, COUNT(DISTINCT country) AS countries, COUNT(DISTINCT referrer) AS referrers FROM visits WHERE ts >= ?${botClause}`
      )
      .bind(startIso)
      .first(),
    db.prepare('SELECT COUNT(*) AS bots FROM visits WHERE ts >= ? AND is_bot = 1').bind(startIso).first(),
    db
      .prepare(
        `SELECT date(ts, '+8 hours') AS day, COUNT(*) AS visits, COUNT(DISTINCT ip) AS uniques FROM visits WHERE ts >= ?${botClause} GROUP BY day ORDER BY day`
      )
      .bind(startIso)
      .all(),
    db
      .prepare(
        `SELECT referrer, COUNT(*) AS visits FROM visits WHERE ts >= ?${botClause} GROUP BY referrer ORDER BY visits DESC LIMIT 10`
      )
      .bind(startIso)
      .all(),
    db
      .prepare(
        `SELECT country, COUNT(*) AS visits FROM visits WHERE ts >= ?${botClause} GROUP BY country ORDER BY visits DESC LIMIT 10`
      )
      .bind(startIso)
      .all(),
    db
      .prepare(
        `SELECT city, country, COUNT(*) AS visits FROM visits WHERE ts >= ?${botClause} GROUP BY city, country ORDER BY visits DESC LIMIT 10`
      )
      .bind(startIso)
      .all(),
    db
      .prepare(`SELECT ts, ip, country, city, referrer FROM visits WHERE ts >= ?${botClause} ORDER BY ts DESC LIMIT 200`)
      .bind(startIso)
      .all(),
  ]);

  const totals = totalsRow ?? { visits: 0, uniques: 0, countries: 0, referrers: 0 };

  return {
    range: { days, timezone: TIMEZONE, include_bots: includeBots },
    totals: {
      visits: totals.visits ?? 0,
      uniques: totals.uniques ?? 0,
      bots: botsRow?.bots ?? 0,
      countries: totals.countries ?? 0,
      referrers: totals.referrers ?? 0,
    },
    daily: fillDaily(dates, dailyRows.results ?? []),
    top_referrers: referrerRows.results ?? [],
    top_countries: countryRows.results ?? [],
    top_cities: cityRows.results ?? [],
    recent: recentRows.results ?? [],
  };
}

export async function handleStats(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!env.STATS_KEY || !safeEqual(key, env.STATS_KEY)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const days = parseDays(url.searchParams.get('days'));
  const includeBots = url.searchParams.get('bots') === '1';

  try {
    const data = await getStats(env.DB, { days, includeBots, now: new Date() });
    return jsonResponse(data, 200, { 'Cache-Control': 'no-store' });
  } catch {
    return jsonResponse({ error: 'server error' }, 500);
  }
}

function jsonResponse(value, status, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
