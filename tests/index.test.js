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
  const collected = await worker.fetch(jsonRequest('https://w.dev/collect', {}, { headers: { Origin: ORIGIN } }), e, {});
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
