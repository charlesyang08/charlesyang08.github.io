export const STORAGE_KEY = 'visitor_stats_key';
export const STATS_ENDPOINT = 'https://visitor-stats.jamestyang2010.workers.dev/stats';

const TZ_NOTE = 'Daily buckets in Asia/Shanghai (UTC+8)';

const regionNames =
  typeof Intl !== 'undefined' && Intl.DisplayNames ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;

const state = {
  key: '',
  days: 30,
  includeBots: false,
  charts: [],
};

export function formatCountry(code) {
  if (!code) return 'Unknown';
  if (!regionNames) return code;
  try {
    const name = regionNames.of(code);
    return !name || name === 'Unknown Region' ? code : name;
  } catch {
    return code;
  }
}

export function formatLocation(city, region, country) {
  const parts = [];
  if (city) parts.push(city);
  if (region) parts.push(region);

  const countryName = country ? formatCountry(country) : '';
  if (countryName && countryName !== 'Unknown') parts.push(countryName);

  const unique = [];
  for (const part of parts) {
    if (!unique.some((value) => value.toLowerCase() === part.toLowerCase())) unique.push(part);
  }
  return unique.length ? unique.join(', ') : 'Unknown';
}

export function formatCount(value) {
  return Number(value || 0).toLocaleString('en-US');
}

export function formatDayLabel(date) {
  return String(date || '').slice(5);
}

export function buildStatsUrl(base, days, includeBots) {
  return `${base}?days=${days}${includeBots ? '&bots=1' : ''}`;
}

export function errorMessage(status) {
  if (status === 401) return 'That key did not work.';
  if (status === 0) return 'Could not load data. Check your connection and try again.';
  return 'The server had a problem. Try again in a moment.';
}

function byId(id) {
  return document.getElementById(id);
}

function readStoredKey() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function writeStoredKey(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage can be unavailable in private windows; the key still works in memory.
  }
}

function clearStoredKey() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

function makeCell(text, className) {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function makeRow(cells) {
  const row = document.createElement('tr');
  for (const cell of cells) row.appendChild(cell);
  return row;
}


function renderCountries(rows) {
  const body = byId('country-body');
  body.textContent = '';
  if (!rows.length) {
    body.appendChild(makeRow([makeCell('No data', 'muted'), makeCell('', 'num')]));
    return;
  }
  for (const row of rows) {
    body.appendChild(makeRow([makeCell(formatCountry(row.country)), makeCell(formatCount(row.visits), 'num')]));
  }
}

function renderCities(rows) {
  const body = byId('city-body');
  body.textContent = '';
  if (!rows.length) {
    body.appendChild(
      makeRow([makeCell('No data', 'muted'), makeCell(''), makeCell(''), makeCell('', 'num')])
    );
    return;
  }
  for (const row of rows) {
    body.appendChild(
      makeRow([
        makeCell(row.city || 'Unknown'),
        makeCell(row.region || '—'),
        makeCell(formatCountry(row.country)),
        makeCell(formatCount(row.visits), 'num'),
      ])
    );
  }
}

function renderRecent(rows) {
  const body = byId('recent-body');
  body.textContent = '';
  if (!rows.length) {
    body.appendChild(
      makeRow([makeCell('No visits in this range.', 'muted'), makeCell(''), makeCell(''), makeCell('')])
    );
    return;
  }
  for (const row of rows) {
    body.appendChild(
      makeRow([
        makeCell(new Date(row.ts).toLocaleString()),
        makeCell(row.ip || 'Unknown'),
        makeCell(formatLocation(row.city, row.region, row.country)),
        makeCell(row.referrer || '(direct)'),
      ])
    );
  }
}

function destroyCharts() {
  for (const chart of state.charts) chart.destroy();
  state.charts = [];
}

function chartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { color: '#6E7770' } } },
    scales: {
      x: { ticks: { color: '#6E7770' }, grid: { color: '#E1E5DA' } },
      y: { beginAtZero: true, ticks: { color: '#6E7770', precision: 0 }, grid: { color: '#E1E5DA' } },
    },
  };
}

function renderCharts(data) {
  destroyCharts();
  if (typeof Chart === 'undefined') return;

  const daily = data.daily || [];
  state.charts.push(
    new Chart(byId('daily-chart'), {
      type: 'line',
      data: {
        labels: daily.map((row) => formatDayLabel(row.date)),
        datasets: [
          {
            label: 'Visits',
            data: daily.map((row) => row.visits),
            borderColor: '#7C9773',
            backgroundColor: 'rgba(124,151,115,.14)',
            fill: true,
            tension: 0.3,
            pointRadius: 2,
          },
          {
            label: 'Unique visitors',
            data: daily.map((row) => row.uniques),
            borderColor: '#E2A98F',
            backgroundColor: 'rgba(226,169,143,.12)',
            fill: true,
            tension: 0.3,
            pointRadius: 2,
          },
        ],
      },
      options: chartOptions(),
    })
  );

  const refs = (data.top_referrers || []).slice(0, 10);
  state.charts.push(
    new Chart(byId('referrer-chart'), {
      type: 'bar',
      data: {
        labels: refs.length ? refs.map((row) => row.referrer) : ['No data'],
        datasets: [
          {
            label: 'Visits',
            data: refs.length ? refs.map((row) => row.visits) : [0],
            backgroundColor: '#7C9773',
            borderRadius: 4,
          },
        ],
      },
      options: { ...chartOptions(), indexAxis: 'y' },
    })
  );
}

function render(data) {
  byId('stat-visits').textContent = formatCount(data.totals.visits);
  byId('stat-uniques').textContent = formatCount(data.totals.uniques);
  byId('stat-countries').textContent = formatCount(data.totals.countries);
  byId('stat-referrers').textContent = formatCount(data.totals.referrers);
  byId('updated').textContent = `Updated ${new Date().toLocaleString()} · ${TZ_NOTE}`;

  renderCountries(data.top_countries || []);
  renderCities(data.top_cities || []);
  renderRecent(data.recent || []);
  renderCharts(data);
}

function showGate(message = '') {
  byId('app').hidden = true;
  byId('gate').hidden = false;
  byId('gate-error').textContent = message;
  byId('key-input').value = '';
}

function showApp() {
  byId('gate').hidden = true;
  byId('app').hidden = false;
}

async function load() {
  const status = byId('status');
  status.textContent = 'Loading...';

  try {
    const response = await fetch(buildStatsUrl(STATS_ENDPOINT, state.days, state.includeBots), {
      headers: { Authorization: `Bearer ${state.key}` },
      cache: 'no-store',
    });

    if (!response.ok) {
      const message = errorMessage(response.status);
      if (response.status === 401) {
        clearStoredKey();
        state.key = '';
        showGate(message);
        return { ok: false, message, unauthorized: true };
      }
      status.textContent = message;
      return { ok: false, message };
    }

    const data = await response.json();
    render(data);

    if (data.totals.visits === 0) {
      status.textContent = 'No visits in this range yet.';
    } else if (typeof Chart === 'undefined') {
      status.textContent = 'Charts unavailable. Tables are still shown.';
    } else {
      status.textContent = '';
    }

    return { ok: true };
  } catch {
    const message = errorMessage(0);
    status.textContent = message;
    return { ok: false, message };
  }
}

export function init() {
  const gate = byId('gate');
  const app = byId('app');
  const gateForm = byId('gate-form');
  const gateError = byId('gate-error');
  const keyInput = byId('key-input');

  const saved = readStoredKey();
  if (saved) {
    state.key = saved;
    showApp();
    load();
  } else {
    gate.hidden = false;
    app.hidden = true;
  }

  gateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const key = keyInput.value.trim();
    if (!key) return;

    state.key = key;
    gateError.textContent = '';
    const result = await load();

    if (result.ok) {
      writeStoredKey(key);
      showApp();
      for (const chart of state.charts) chart.resize();
    } else {
      gateError.textContent = result.message;
    }
  });

  document.querySelectorAll('[data-days]').forEach((button) => {
    button.addEventListener('click', () => {
      state.days = Number(button.dataset.days);
      document.querySelectorAll('[data-days]').forEach((candidate) => {
        candidate.classList.toggle('active', candidate === button);
      });
      load();
    });
  });

  byId('bots-toggle').addEventListener('change', (event) => {
    state.includeBots = event.target.checked;
    load();
  });

  byId('sign-out').addEventListener('click', () => {
    clearStoredKey();
    state.key = '';
    destroyCharts();
    showGate();
    byId('status').textContent = '';
    byId('updated').textContent = '';
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
