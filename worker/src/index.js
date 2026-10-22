import { handleCollect } from './collect.js';
import { handleStats } from './stats.js';
import { corsHeaders } from './lib.js';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request.headers.get('Origin'), env.ALLOWED_ORIGIN);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    let response;

    if (request.method === 'POST' && url.pathname === '/collect') {
      response = await handleCollect(request, env, request.cf ?? {});
    } else if (request.method === 'GET' && url.pathname === '/stats') {
      response = await handleStats(request, env);
    } else {
      response = new Response('Not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(cors)) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  },

  async scheduled(controller, env) {
    const cutoff = new Date(Date.now() - 365 * 86400000).toISOString();
    await env.DB.prepare('DELETE FROM visits WHERE ts < ?').bind(cutoff).run();
  },
};
