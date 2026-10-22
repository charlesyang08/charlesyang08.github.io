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
