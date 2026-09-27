/**
 * Unit tests for the measurement-window arithmetic.
 *
 * Worth testing in isolation because the numbers are easy to get subtly wrong and
 * impossible to eyeball. Phase records contain **composite** entries — `login`
 * wraps `nav_login` + `fill_credentials` + `submit_credentials`, `documents` wraps
 * the list and download steps — so summing every phase in a run exceeds its wall
 * clock. Measured on a real Progressive run: 45,394ms of phases against 40,158ms
 * of wall clock.
 *
 * Any "exclude this from the total" feature therefore has to subtract only
 * non-overlapping leaf phases, or it silently double-counts and reports a latency
 * lower than reality — which is the worst direction for a number that exists to
 * prove a performance claim.
 *
 *   node tools/test-windows.js
 */

const {
  windowedDuration,
  WINDOWS,
  isComposite,
  COMPOSITE_PHASES,
  summarise,
  normalisePhase,
} = await import('../src/telemetry/metricsStore.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** Shape taken from a real Progressive run, including the composite overlap. */
const run = {
  wallMs: 40158,
  phases: [
    { phase: 'acquire_context', durationMs: 820 },
    { phase: 'nav_login', durationMs: 1700 },
    { phase: 'fill_credentials', durationMs: 1430 },
    { phase: 'submit_credentials', durationMs: 44 },
    { phase: 'login', durationMs: 9438 },
    { phase: 'mfa_wait', durationMs: 16018, human: true },
    { phase: 'mfa_submit', durationMs: 8069 },
    { phase: 'nav_documents', durationMs: 1 },
    { phase: 'list_documents', durationMs: 351 },
    { phase: 'list_documents_via_page', durationMs: 1779 },
    { phase: 'document_download', durationMs: 3200 },
    { phase: 'documents', durationMs: 5630 },
    { phase: 'persist_session', durationMs: 114 },
  ],
};

console.log('Measurement window arithmetic\n');

for (const key of Object.keys(WINDOWS)) {
  console.log(
    `  ${key.padEnd(14)} ${String(windowedDuration(run, key)).padStart(6)}ms   excludes [${WINDOWS[key].subtract.join(', ') || 'nothing'}]`
  );
}
console.log('');

check('wall equals wallMs', windowedDuration(run, 'wall') === 40158);
check('exclHuman subtracts only mfa_wait', windowedDuration(run, 'exclHuman') === 40158 - 16018);
check(
  'exclDownload subtracts only document_download',
  windowedDuration(run, 'exclDownload') === 40158 - 3200
);
check('exclBoth subtracts both', windowedDuration(run, 'exclBoth') === 40158 - 16018 - 3200);

// The invariant that protects against double-counting.
check(
  'no window subtracts a composite phase',
  Object.values(WINDOWS).every((w) => w.subtract.every((p) => !isComposite(p))),
  Object.entries(WINDOWS)
    .filter(([, w]) => w.subtract.some(isComposite))
    .map(([k]) => k)
    .join(', ') || 'all clean'
);

// And that the phases we subtract are genuinely inside a composite, i.e. the
// composite map is not stale relative to what the adapters emit.
check(
  'document_download is listed under the documents composite',
  COMPOSITE_PHASES.documents.includes('document_download')
);

check('composites identified', isComposite('login') && isComposite('documents'));
check('leaves not misidentified', !isComposite('mfa_wait') && !isComposite('document_download'));

// Demonstrates the hazard the invariant prevents.
const naive = run.phases.reduce((a, p) => a + p.durationMs, 0);
check(
  'naive sum of all phases exceeds wall clock (why leaves-only matters)',
  naive > run.wallMs,
  `sum=${naive}ms wall=${run.wallMs}ms`
);

// Never produce a negative duration, however odd the record.
const weird = { wallMs: 100, phases: [{ phase: 'mfa_wait', durationMs: 9999 }] };
check('clamps at zero rather than going negative', windowedDuration(weird, 'exclHuman') === 0);

// A run with no excludable phases must be unaffected.
const warm = {
  wallMs: 400,
  phases: [
    { phase: 'acquire_context', durationMs: 40 },
    { phase: 'warm_validate', durationMs: 30 },
  ],
};
check(
  'warm run without MFA or transfer is identical across windows',
  windowedDuration(warm, 'wall') === 400 &&
    windowedDuration(warm, 'exclHuman') === 400 &&
    windowedDuration(warm, 'exclBoth') === 400
);

check('unknown window falls back to wall', windowedDuration(run, 'nonsense') === 40158);
check('attempt suffix normalised', normalisePhase('mfa_submit_2') === 'mfa_submit');
check('empty sample set returns nulls', summarise([]).median === null);

console.log(`\n${failures === 0 ? 'ALL WINDOW CHECKS PASSED' : `${failures} WINDOW CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
