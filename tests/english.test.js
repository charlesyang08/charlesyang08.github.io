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
const CJK = /[㐀-䶿一-鿿豈-﫿]/;

for (const file of FILES) {
  test(`no Chinese characters in ${file}`, () => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.equal(CJK.test(text), false, `${file} contains CJK characters`);
  });
}
