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
