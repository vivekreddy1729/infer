/* eslint-env browser */

/**
 * Metrics page renderer.
 *
 * Charts are hand-built from divs rather than pulled from a charting library.
 * The requirement is min/max/avg/median per phase, which is four numbers on a
 * shared axis — a horizontal range bar shows that in one row without adding a
 * dependency to a project whose premise is running unattended in a container. It
 * also works with no network access, which a CDN-hosted library would not.
 *
 * Filters are multi-select because the useful questions are comparative:
 * "Progressive cold versus warm", "everything except the practice portal".
 * Single-select forces those to be answered by flipping views and remembering
 * numbers.
 */

const el = (id) => document.getElementById(id);

const ui = {
  carrier: el('f-carrier'),
  path: el('f-path'),
  outcome: el('f-outcome'),
  window: el('f-window'),
  since: el('f-since'),
  refresh: el('refresh'),
  reset: el('reset'),
  note: el('filter-note'),
  summary: el('summary'),
  windows: el('windows'),
  breakdown: el('breakdown'),
  phases: el('phases'),
  recent: el('recent'),
};

/** Human-readable labels for the orchestrator's internal phase names. */
const PHASE_LABELS = {
  acquire_context: 'Acquire browser context',
  adopt_prewarmed: 'Adopt pre-warmed login page',
  nav_login: 'Navigate to login page',
  await_login_form: 'Wait for login form to render',
  fill_credentials: 'Type credentials',
  submit_credentials: 'Submit credentials',
  login: 'Login (total)',
  mfa_wait: 'Waiting on the person',
  mfa_submit: 'Submit verification code',
  warm_validate: 'Validate saved session',
  nav_documents: 'Reach authenticated route',
  capture_api_auth: 'Capture API credentials',
  list_documents: 'List documents (direct API)',
  list_documents_via_page: 'List documents (page fallback)',
  document_download: 'Download document bytes',
  documents: 'Documents (total)',
  persist_session: 'Persist session',
};

const PATH_LABELS = {
  cold: 'Cold — full sign-in + MFA',
  warm: 'Warm — saved session',
  resumed: 'Resumed — SSO',
};

const label = (p) => PHASE_LABELS[p] ?? p;
const ms = (v) =>
  v === null || v === undefined ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;

/** Filter state. `null` for an identity filter means "no restriction". */
const state = {
  carrier: new Set(),
  path: new Set(),
  outcome: new Set(['COMPLETED']),
  window: 'exclHuman',
  since: '',
};

// ---------------------------------------------------------------------------
// Checkbox groups
// ---------------------------------------------------------------------------

/**
 * Render a checkbox group, preserving any selection that is still valid.
 *
 * Rebuilt from the server's `available` lists rather than hardcoded, so a carrier
 * appears as soon as it has produced a single run.
 */
function renderChecks(container, values, selected, onChange, labels = {}) {
  const signature = values.join('|');
  if (container.dataset.built !== signature) {
    container.innerHTML = values
      .map(
        (v) => `<label class="check">
            <input type="checkbox" value="${v}">
            <span>${labels[v] ?? v}</span>
          </label>`
      )
      .join('');
    container.dataset.built = signature;

    container.addEventListener('change', (event) => {
      const box = event.target;
      if (box.tagName !== 'INPUT') return;
      if (box.checked) selected.add(box.value);
      else selected.delete(box.value);
      onChange();
    });
  }

  for (const box of container.querySelectorAll('input')) {
    box.checked = selected.has(box.value);
  }
}

/** Radio group for the measurement window; exactly one applies to the headline. */
function renderWindowChoices(windows) {
  const signature = windows.map((w) => w.key).join('|');
  if (ui.window.dataset.built !== signature) {
    ui.window.innerHTML = windows
      .map(
        (w) => `<label class="check">
            <input type="radio" name="window" value="${w.key}">
            <span>${w.label}</span>
          </label>`
      )
      .join('');
    ui.window.dataset.built = signature;

    ui.window.addEventListener('change', (event) => {
      if (event.target.name !== 'window') return;
      state.window = event.target.value;
      load();
    });
  }
  for (const box of ui.window.querySelectorAll('input')) {
    box.checked = box.value === state.window;
  }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

async function load() {
  const params = new URLSearchParams();
  if (state.carrier.size) params.set('carrierId', [...state.carrier].join(','));
  if (state.path.size) params.set('path', [...state.path].join(','));
  if (state.outcome.size) params.set('outcome', [...state.outcome].join(','));
  if (state.window) params.set('window', state.window);
  if (state.since) params.set('sinceHours', state.since);

  let data;
  try {
    const res = await fetch(`/api/metrics?${params}`);
    data = await res.json();
  } catch (err) {
    ui.phases.innerHTML = `<p class="error">Could not load metrics: ${err.message}</p>`;
    return;
  }

  const avail = data.available ?? {};
  renderChecks(ui.carrier, avail.carriers ?? [], state.carrier, load);
  renderChecks(ui.path, avail.paths ?? [], state.path, load, PATH_LABELS);
  renderChecks(ui.outcome, avail.outcomes ?? [], state.outcome, load);
  renderWindowChoices(avail.windows ?? []);

  renderSummary(data);
  renderWindows(data);
  renderBreakdown(data);
  renderPhases(data.phases, data);
  renderRecent(data.recent, data);

  const f = data.filters;
  ui.note.textContent =
    `${data.runs.matched} of ${data.runs.total} run(s) matched · ` +
    `carriers: ${f.carrierId?.join(', ') || 'all'} · ` +
    `paths: ${f.path?.join(', ') || 'all'} · ` +
    `outcomes: ${f.outcome.join(', ')} · ` +
    `generated ${new Date(data.generatedAt).toLocaleTimeString()}`;
}

function renderSummary(data) {
  const h = data.headline;
  const windowLabel = data.windows?.[data.filters.window]?.label ?? '';

  if (!h.count) {
    ui.summary.innerHTML = `<p class="hint">
      No runs match these filters. ${data.runs.total > 0 ? 'Try enabling the ERROR outcome, or widening the carrier/path selection.' : 'Run a pull and refresh.'}
    </p>`;
    return;
  }

  const budget = data.withinBudget;
  const cards = [
    { k: 'Runs matched', v: h.count },
    { k: `Median · ${windowLabel}`, v: ms(h.median), big: true },
    { k: 'Average', v: ms(h.avg) },
    { k: 'Fastest', v: ms(h.min) },
    { k: 'Slowest', v: ms(h.max) },
    { k: 'p95', v: ms(h.p95) },
    {
      k: 'Within 8s (this window)',
      v: budget === null ? '—' : `${budget}%`,
      cls: budget === 100 ? 'ok' : budget >= 80 ? '' : 'warn',
    },
  ];

  ui.summary.innerHTML = cards
    .map(
      (c) => `<div class="stat ${c.cls ?? ''}">
           <div class="stat-v ${c.big ? 'big' : ''}">${c.v}</div>
           <div class="stat-k">${c.k}</div>
         </div>`
    )
    .join('');
}

/**
 * Every window over the same run set.
 *
 * Shown together rather than only the selected one, because the comparison is
 * the insight: the gap between "wall clock" and "excluding MFA wait" is how much
 * of the experience is the person, and the gap to "excluding transfer" is how
 * much is the network.
 */
function renderWindows(data) {
  const windows = Object.values(data.windows ?? {});
  if (!windows.length || !data.headline.count) {
    ui.windows.innerHTML = '';
    return;
  }

  ui.windows.innerHTML = `
    <table class="windows">
      <thead><tr>
        <th>Window</th><th>Excludes</th>
        <th class="num">Median</th><th class="num">Avg</th>
        <th class="num">Min</th><th class="num">Max</th><th class="num">p95</th>
      </tr></thead>
      <tbody>
        ${windows
          .map(
            (w) => `<tr class="${w.key === data.filters.window ? 'row-selected' : ''}">
              <td>${w.label}${w.key === data.filters.window ? ' <small>(headline)</small>' : ''}</td>
              <td><small>${w.subtract.length ? w.subtract.map(label).join(', ') : '—'}</small></td>
              <td class="num strong">${ms(w.stats.median)}</td>
              <td class="num">${ms(w.stats.avg)}</td>
              <td class="num">${ms(w.stats.min)}</td>
              <td class="num">${ms(w.stats.max)}</td>
              <td class="num">${ms(w.stats.p95)}</td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
}

function renderBreakdown(data) {
  const parts = [];
  const add = (title, obj, cls = '') => {
    if (!obj || !Object.keys(obj).length) return;
    parts.push(
      `<div><h3>${title}</h3>${Object.entries(obj)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `<span class="chip ${cls}">${k}: <strong>${v}</strong></span>`)
        .join('')}</div>`
    );
  };
  add('By carrier', data.runs.byCarrier);
  add('By auth path', data.runs.byPath);
  add('By outcome', data.runs.byOutcome);
  add('Failure reasons', data.runs.errorCodes, 'err');
  ui.breakdown.innerHTML = parts.join('');
}

/**
 * Range bars on a shared scale.
 *
 * A shared maximum across phases is the point: it makes the dominant step
 * obvious, which a per-row scale would flatten away.
 */
function renderPhases(phases, data) {
  if (!phases?.length) {
    ui.phases.innerHTML = '<p class="hint">No phase data for this selection.</p>';
    return;
  }

  const excluded = new Set(data.windows?.[data.filters.window]?.subtract ?? []);
  const scale = Math.max(...phases.map((p) => p.max ?? 0)) || 1;
  const pct = (v) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`;

  ui.phases.innerHTML = phases
    .map((p) => {
      const spread = p.max - p.min;
      const tags = [
        p.human ? '<span class="tag">human</span>' : '',
        p.composite ? '<span class="tag composite">total</span>' : '',
        excluded.has(p.phase) ? '<span class="tag excluded">excluded</span>' : '',
      ].join('');
      return `
      <div class="phase-row${p.human ? ' human' : ''}${excluded.has(p.phase) ? ' is-excluded' : ''}">
        <div class="phase-name">
          ${label(p.phase)}${tags}
          <span class="phase-n">n=${p.count}</span>
        </div>
        <div class="phase-track" title="min ${ms(p.min)} · median ${ms(p.median)} · avg ${ms(p.avg)} · p95 ${ms(p.p95)} · max ${ms(p.max)}">
          <div class="range" style="left:${pct(p.min)};width:${pct(spread)}"></div>
          <div class="fill" style="left:${pct(p.min)};width:${pct(Math.max(0, p.avg - p.min))}"></div>
          <div class="median" style="left:${pct(p.median)}"></div>
          <div class="p95" style="left:${pct(p.p95)}"></div>
        </div>
        <div class="phase-nums">
          <span title="minimum">${ms(p.min)}</span>
          <span title="median" class="strong">${ms(p.median)}</span>
          <span title="average">${ms(p.avg)}</span>
          <span title="maximum">${ms(p.max)}</span>
        </div>
      </div>`;
    })
    .join('');

  ui.phases.innerHTML += `
    <div class="legend">
      <span><i class="sw range"></i>min–max range</span>
      <span><i class="sw fill"></i>up to average</span>
      <span><i class="sw median"></i>median</span>
      <span><i class="sw p95"></i>p95</span>
      <span class="hint">scale 0 – ${ms(scale)}</span>
      <span class="hint">rows marked <em>total</em> wrap the steps beneath them, so they are not additive</span>
    </div>`;
}

function renderRecent(recent, data) {
  if (!recent?.length) {
    ui.recent.innerHTML = '<p class="hint">No runs match this selection.</p>';
    return;
  }
  const windowLabel = data.windows?.[data.filters.window]?.label ?? 'selected';
  ui.recent.innerHTML = `
    <table class="recent">
      <thead><tr>
        <th>When</th><th>Carrier</th><th>Path</th><th>Outcome</th>
        <th class="num">${windowLabel}</th><th class="num">Wall</th>
        <th class="num">MFA wait</th><th class="num">Transfer</th><th class="num">Docs</th>
      </tr></thead>
      <tbody>
        ${recent
          .map(
            (r) => `<tr class="${r.outcome === 'ERROR' ? 'row-err' : ''}">
              <td>${new Date(r.at).toLocaleString()}</td>
              <td>${r.carrierId}</td>
              <td>${r.path}</td>
              <td>${r.outcome === 'ERROR' ? `ERROR <small>${r.errorCode ?? ''}</small>` : 'OK'}</td>
              <td class="num strong">${ms(r.selectedMs)}</td>
              <td class="num">${ms(r.wallMs)}</td>
              <td class="num">${r.humanMs ? ms(r.humanMs) : '—'}</td>
              <td class="num">${r.downloadMs ? ms(r.downloadMs) : '—'}</td>
              <td class="num">${r.documents}</td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
}

ui.refresh.addEventListener('click', load);
ui.since.addEventListener('change', () => {
  state.since = ui.since.value;
  load();
});
ui.reset.addEventListener('click', () => {
  state.carrier.clear();
  state.path.clear();
  state.outcome = new Set(['COMPLETED']);
  state.window = 'exclHuman';
  state.since = '';
  ui.since.value = '';
  load();
});

load();
