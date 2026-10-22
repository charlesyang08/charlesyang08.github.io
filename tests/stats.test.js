import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRange, parseDays, fillDaily, getStats, handleStats } from '../worker/src/stats.js';
import { mockDb } from './helpers.js';

const NOW = new Date('2026-10-22T17:30:00.000Z');

function resolveStats(sql) {
  if (/GROUP BY day/.test(sql)) return [{ day: '2026-10-22', visits: 3, uniques: 2 }];
  if (/GROUP BY referrer/.test(sql)) return [{ referrer: '(direct)', visits: 5 }];
  if (/GROUP BY country/.test(sql)) return [{ country: 'JP', visits: 3 }];
  if (/GROUP BY city/.test(sql)) return [{ city: 'Tokyo', region: 'Tokyo', country: 'JP', visits: 2 }];
  if (/ORDER BY ts DESC/.test(sql))
    return [
      {
        ts: '2026-10-22T10:00:00.000Z',
        ip: '203.0.113.9',
        country: 'JP',
        region: 'Tokyo',
        city: 'Tokyo',
        referrer: '(direct)',
      },
    ];
  if (/AS bots/.test(sql)) return [{ bots: 2 }];
  if (/AS visits/.test(sql)) return [{ visits: 12, uniques: 9, countries: 3, referrers: 4 }];
  return [];
}

test('buildRange buckets days in Asia/Shanghai', () => {
  const range = buildRange(NOW, 3);
  assert.equal(range.startIso, '2026-10-20T16:00:00.000Z');
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
  assert.equal(dailyCall.args[0], '2026-10-20T16:00:00.000Z');

  const cityCall = db.calls.find((c) => /GROUP BY city/.test(c.sql));
  assert.match(cityCall.sql, /region/);
  const recentCall = db.calls.find((c) => /ORDER BY ts DESC/.test(c.sql));
  assert.match(recentCall.sql, /region/);
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
    assert.doesNotMatch(call.sql, /\b(ua|user_agent|asn|as_org|screen|lang|language|device)\b/i);
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
  assert.deepEqual(data.top_cities, [{ city: 'Tokyo', region: 'Tokyo', country: 'JP', visits: 2 }]);
  assert.equal(data.recent[0].ip, '203.0.113.9');
  assert.deepEqual(Object.keys(data.recent[0]).sort(), ['city', 'country', 'ip', 'referrer', 'region', 'ts']);
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
