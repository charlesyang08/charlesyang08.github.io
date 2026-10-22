export function mockDb(resolve = () => []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const state = { sql, args: [] };
      const stmt = {
        bind(...args) {
          state.args = args;
          return stmt;
        },
        async run() {
          calls.push({ ...state, kind: 'run' });
          return { success: true, meta: { changes: 1 } };
        },
        async all() {
          calls.push({ ...state, kind: 'all' });
          return { results: resolve(sql, state.args), success: true, meta: {} };
        },
        async first() {
          calls.push({ ...state, kind: 'first' });
          const rows = resolve(sql, state.args);
          return Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null);
        },
      };
      return stmt;
    },
  };
}

export function jsonRequest(url, body, { method = 'POST', headers = {}, ...rest } = {}) {
  return new Request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...rest,
  });
}
