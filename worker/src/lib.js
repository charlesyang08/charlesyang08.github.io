const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|bingpreview|facebookexternalhit|embedly|telegrambot|whatsapp|discordbot/i;
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function isBot(ua) {
  if (!ua) return true;
  return BOT_RE.test(ua);
}

export function normalizeReferrer(ref, selfHost) {
  if (!ref) return '(direct)';
  try {
    const url = new URL(ref);
    if (!url.hostname || url.hostname === selfHost) return '(direct)';
    return url.hostname;
  } catch {
    return '(direct)';
  }
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function corsHeaders(origin, allowedOrigin) {
  if (!origin) return {};
  if (origin !== allowedOrigin && !LOCAL_ORIGIN_RE.test(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
