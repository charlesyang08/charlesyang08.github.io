import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');

test('visits table stores exactly the documented fields', () => {
  const block = sql.match(/CREATE TABLE IF NOT EXISTS visits \(([\s\S]*?)\);/);
  assert.ok(block, 'visits table definition not found');

  const columns = block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('--'))
    .map((line) => line.split(/\s+/)[0]);

  assert.deepEqual(columns, ['id', 'ts', 'ip', 'country', 'region', 'city', 'referrer', 'is_bot']);
});
