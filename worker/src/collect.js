import { isBot, normalizeReferrer } from './lib.js';

const SITE_HOST = 'charlesyang08.github.io';
const MAX_BODY_LENGTH = 2048;
const INSERT_SQL =
  'INSERT INTO visits (ts, ip, country, region, city, referrer, is_bot) VALUES (?,?,?,?,?,?,?)';

export function buildVisitRow({ headers, cf, body, ip, now }) {
  const referrer = normalizeReferrer(body.referrer, SITE_HOST).slice(0, 255);
  return [
    now.toISOString(),
    ip || 'unknown',
    cf.country || null,
    cf.region || null,
    cf.city || null,
    referrer,
    isBot(headers.get('User-Agent')) ? 1 : 0,
  ];
}

export async function handleCollect(request, env, cf, now = new Date()) {
  try {
    const declaredLength = Number(request.headers.get('Content-Length') || 0);
    if (declaredLength > MAX_BODY_LENGTH) return new Response(null, { status: 204 });

    const text = await request.text();
    if (text.length > MAX_BODY_LENGTH) return new Response(null, { status: 204 });

    const parsed = JSON.parse(text || '{}');
    const body = parsed && typeof parsed === 'object' ? parsed : {};
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const row = buildVisitRow({
      headers: request.headers,
      cf: cf ?? {},
      body,
      ip,
      now,
    });

    await env.DB.prepare(INSERT_SQL).bind(...row).run();
  } catch {
    // Collection must never break the page.
  }
  return new Response(null, { status: 204 });
}
