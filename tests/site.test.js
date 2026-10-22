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
