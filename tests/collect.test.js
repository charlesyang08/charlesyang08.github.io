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
