/**
 * Metrics page smoke test.
 *
 * Asserts the page actually renders numbers rather than just returning 200, and
 * that the chart geometry is sane — bars inside their track, median between min
 * and max. A chart that silently renders zero-width bars looks fine to an HTTP
 * check and is useless to a human, which is the same lesson the hidden-overlay
 * bug taught.
 *
 *   node tools/smoke-metrics.js [baseUrl]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';

process.env.HEADLESS = process.env.HEADLESS ?? 'true';
const { default: browserPool } = await import('../src/browser/browserPool.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const lease = await browserPool.acquireContext({});
const page = await lease.context.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 140));
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 140)}`));

console.log(`Metrics page smoke test against ${BASE}\n`);

await page.goto(`${BASE}/metrics.html`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
await page.waitForTimeout(600);

// -- it rendered ------------------------------------------------------------

check('no JS errors on the page', consoleErrors.length === 0, consoleErrors.join(' | '));

const statCount = await page.locator('#summary .stat').count();
check('summary cards rendered', statCount > 0, `${statCount} cards`);

const rows = await page.locator('.phase-row').count();
check('phase rows rendered', rows > 0, `${rows} phases`);

const medianText = await page.locator('#summary .stat-v.big').first().textContent().catch(() => '');
check(
  'headline median shows a real value',
  /\d/.test(medianText ?? ''),
  JSON.stringify((medianText ?? '').trim())
);

// -- multi-select filters ---------------------------------------------------

for (const [name, sel] of [
  ['carrier', '#f-carrier input[type=checkbox]'],
  ['auth path', '#f-path input[type=checkbox]'],
  ['outcome', '#f-outcome input[type=checkbox]'],
]) {
  const n = await page.locator(sel).count();
  check(`${name} filter renders checkboxes (multi-select)`, n > 0, `${n} options`);
}

const windowRadios = await page.locator('#f-window input[type=radio]').count();
check('four measurement windows offered', windowRadios === 4, `${windowRadios}`);

const windowRows = await page.locator('table.windows tbody tr').count();
check('window comparison table rendered', windowRows === 4, `${windowRows} rows`);
check(
  'exactly one window marked as the headline',
  (await page.locator('table.windows tr.row-selected').count()) === 1
);

// -- every phase row shows four distinct statistics --------------------------

const numsPerRow = await page.locator('.phase-row').first().locator('.phase-nums span').count();
check('each row shows 4 numbers (min/median/avg/max)', numsPerRow === 4, `${numsPerRow}`);

/**
 * Geometry sanity. The bars are absolutely positioned percentages, so an
 * off-by-one in the scale maths produces bars that overflow the track or
 * collapse to nothing without throwing anything.
 */
const geometry = await page.locator('.phase-row').evaluateAll((rows) =>
  rows.map((row) => {
    const track = row.querySelector('.phase-track').getBoundingClientRect();
    const g = (sel) => {
      const n = row.querySelector(sel);
      return n ? n.getBoundingClientRect() : null;
    };
    const range = g('.range');
    const median = g('.median');
    return {
      name: row.querySelector('.phase-name')?.innerText?.split('\n')[0]?.trim(),
      trackW: Math.round(track.width),
      rangeInside: range ? range.left >= track.left - 1 && range.right <= track.right + 1 : false,
      medianInside: median ? median.left >= track.left - 1 && median.right <= track.right + 1 : false,
    };
  })
);

check(
  'all range bars sit inside their track',
  geometry.every((g) => g.rangeInside),
  geometry
    .filter((g) => !g.rangeInside)
    .map((g) => g.name)
    .join(', ') || 'all ok'
);
check(
  'all median markers sit inside their track',
  geometry.every((g) => g.medianInside),
  geometry
    .filter((g) => !g.medianInside)
    .map((g) => g.name)
    .join(', ') || 'all ok'
);

// -- statistical invariants, read off the API -------------------------------

const api = await page.evaluate(async () => (await fetch('/api/metrics')).json());
const bad = (api.phases ?? []).filter(
  (p) => !(p.min <= p.median && p.median <= p.max && p.min <= p.avg && p.avg <= p.max)
);
check('min <= median <= max and min <= avg <= max for every phase', bad.length === 0, bad.map((p) => p.phase).join(', '));

const humanPhase = (api.phases ?? []).find((p) => p.phase === 'mfa_wait');
check(
  'the human wait phase is flagged as human',
  !humanPhase || humanPhase.human === true,
  humanPhase ? `human=${humanPhase.human}` : 'no mfa_wait samples yet'
);

// -- window ordering invariant ----------------------------------------------

/**
 * Excluding a phase can only reduce a duration, so wall must be the largest and
 * exclBoth the smallest. Catches a sign error or a double-subtraction, which are
 * otherwise invisible: the numbers still look plausible.
 */
const w = api.windows ?? {};
if (w.wall?.stats?.median != null) {
  check(
    'wall >= exclHuman and wall >= exclDownload',
    w.wall.stats.median >= w.exclHuman.stats.median &&
      w.wall.stats.median >= w.exclDownload.stats.median,
    `wall=${w.wall.stats.median} exclHuman=${w.exclHuman.stats.median} exclDownload=${w.exclDownload.stats.median}`
  );
  check(
    'exclBoth is the smallest window',
    w.exclBoth.stats.median <= Math.min(w.exclHuman.stats.median, w.exclDownload.stats.median),
    `exclBoth=${w.exclBoth.stats.median}`
  );
  check(
    'no window subtracts a composite phase',
    Object.values(w).every((x) => !x.subtract.includes('login') && !x.subtract.includes('documents'))
  );
}

// -- multi-value filtering actually works -----------------------------------

const allInScope = api.runs.total;

const warm = await page.evaluate(async () => (await fetch('/api/metrics?path=warm')).json());
check(
  'single path value narrows the set',
  warm.runs.matched > 0 && warm.runs.matched <= allInScope,
  `all=${allInScope} warm=${warm.runs.matched}`
);
check(
  'warm runs contain no login phase',
  !(warm.phases ?? []).some((p) => p.phase === 'login' || p.phase === 'fill_credentials'),
  (warm.phases ?? []).map((p) => p.phase).join(', ')
);

const both = await page.evaluate(async () => (await fetch('/api/metrics?path=warm,cold')).json());
check(
  'two path values match at least as many runs as one',
  both.runs.matched >= warm.runs.matched,
  `warm=${warm.runs.matched} warm+cold=${both.runs.matched}`
);

const withErrors = await page.evaluate(async () =>
  (await fetch('/api/metrics?outcome=COMPLETED,ERROR')).json()
);
check(
  'outcome filter can include failed runs',
  withErrors.runs.matched >= api.runs.matched,
  `completed=${api.runs.matched} completed+error=${withErrors.runs.matched}`
);

const multiCarrier = await page.evaluate(async () =>
  (await fetch('/api/metrics?carrierId=demo,progressive&outcome=COMPLETED,ERROR')).json()
);
check(
  'multiple carriers can be selected together',
  Object.keys(multiCarrier.runs.byCarrier ?? {}).length >= 1,
  JSON.stringify(multiCarrier.runs.byCarrier)
);

// A carrier with only failures must still be discoverable, which was the
// motivating complaint: selecting it showed nothing because phase stats were
// hardcoded to successful runs.
check(
  'available carrier list is built from all runs, not just successful ones',
  (api.available?.carriers ?? []).length >= Object.keys(api.runs.byCarrier ?? {}).length,
  `available=${JSON.stringify(api.available?.carriers)}`
);

const recentRows = await page.locator('table.recent tbody tr').count();
check('recent runs table populated', recentRows > 0, `${recentRows} rows`);

console.log(`\n${failures === 0 ? 'ALL METRICS CHECKS PASSED' : `${failures} METRICS CHECK(S) FAILED`}`);

await lease.release();
await browserPool.shutdown();
process.exit(failures === 0 ? 0 : 1);
