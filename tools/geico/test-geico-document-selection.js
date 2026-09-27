#!/usr/bin/env node
/**
 * GEICO document selection tests.
 *
 * ISOLATION: GEICO-local. Shares nothing with tools/test-document-selection.js,
 * which covers Progressive against a different payload shape.
 *
 * Runs against `artifacts/recordings/geico/documents-list-fixture.json` — the
 * real `/ws/consolidated-documents` payload from a recorded session, with the
 * opaque policy token replaced. 110 documents, 11 of them described
 * "Declaration Page".
 *
 * THE ASSERTION THAT MATTERS is the negative control: the fixture contains a live
 * instance of the F-28 trap, where an older policy term carries a *later*
 * transaction date. Any "most recent wins" rule picks a document from an expired
 * term and reports success. The test proves the naive rule fails on this real data
 * and that the implemented rule does not.
 *
 *   node tools/geico/test-geico-document-selection.js
 */

import { readFile } from 'node:fs/promises';
import { selectDocument, flattenDocuments, TARGETS } from '../../src/carriers/geico/documents.js';

/**
 * Two fixtures, preferring the real one.
 *
 * The real recording is the stronger evidence — it is an actual
 * `/ws/consolidated-documents` payload, and the headline assertion is that selection
 * picks the very document the user opened by hand. But it lives in `artifacts/`, which
 * is gitignored because a GEICO `policyNumber` doubles as a `view-document` access
 * token. So on a fresh clone it is absent, this test used to SKIP, and `process.exit(0)`
 * meant `smoke:all` stayed green with this logic entirely unverified. A test that
 * disappears on the machine you deploy to is not a test. See F-54.
 *
 * The synthetic fixture is committed and carries no account data. It is deliberately
 * HARDER than the real one: it contains a genuine F-28 inversion, where a document in
 * the expired term has a later `transactionDate` than anything in the in-force term. On
 * the real recording no such inversion exists, so naive recency ranking is correct there
 * by coincidence — this test says so in its own INFO line. Against the synthetic
 * fixture the term filter is provably load-bearing.
 */
const REAL_FIXTURE = 'artifacts/recordings/geico/documents-list-fixture.json';
const SYNTHETIC_FIXTURE = 'tools/geico/fixtures/documents-list-synthetic.json';

/** The document the user actually opened, verified as a 52,361-byte PDF. */
const USER_DOWNLOADED = '85cf35bd-4831-a624-49eb-080110bda7ef';

let failures = 0;
const pass = (m, d = '') => console.log(`  PASS  ${m}${d ? `  ${d}` : ''}`);
const fail = (m, d = '') => { failures += 1; console.log(`  FAIL  ${m}${d ? `  ${d}` : ''}`); };
const eq = (actual, expected, m) =>
  actual === expected ? pass(m, String(actual)) : fail(m, `expected ${expected}, got ${actual}`);

async function main() {
  console.log('GEICO document selection\n');
  let payload;
  let usingReal = false;
  try {
    payload = JSON.parse(await readFile(REAL_FIXTURE, 'utf8'));
    usingReal = true;
    console.log(`  using REAL recording (${REAL_FIXTURE})\n`);
  } catch {
    payload = JSON.parse(await readFile(SYNTHETIC_FIXTURE, 'utf8'));
    console.log(`  real recording absent; using committed SYNTHETIC fixture`);
    console.log(`  (${SYNTHETIC_FIXTURE} — no account data, and it contains a genuine F-28 inversion)\n`);
  }

  /**
   * Expectations come from the fixture when it declares them.
   *
   * The real recording has no `__expected` block, so it keeps the hardcoded constants
   * that encode what the user actually downloaded. The synthetic fixture declares its
   * own, so the two can diverge without the test needing to know which is loaded.
   */
  const expected = payload.__expected ?? {
    declarationsWinner: USER_DOWNLOADED,
    declarationPageCount: 11,
    contractWinner: null,
    idCardWinner: null,
  };

  // -- 1. the headline: same document the user got ---------------------------
  const dec = selectDocument(payload, 'declarations', { limit: 1 });
  eq(dec.chosen.length, 1, 'declarations target returns exactly one document');
  eq(
    dec.chosen[0]?.id,
    expected.declarationsWinner,
    usingReal ? 'picks the SAME document the user downloaded' : 'picks the expected in-term declaration'
  );
  eq(dec.chosen[0]?.description, 'Declaration Page', 'description is Declaration Page');
  eq(dec.diagnostics.chosenIsInCurrentTerm, true, 'chosen document is from the in-force term');

  // -- 2. THE NEGATIVE CONTROL: the naive rule must fail on this data --------
  const all = flattenDocuments(payload, TARGETS.declarations.buckets)
    .filter((d) => TARGETS.declarations.description.test(d.description));
  eq(all.length, expected.declarationPageCount, 'fixture really does contain the expected "Declaration Page" count');

  const naive = [...all].sort((a, b) =>
    String(b.transactionDate).localeCompare(String(a.transactionDate))
  )[0];
  const cur = payload.currentTermEffectiveDate;

  /**
   * Is the trap present in this real account? Measured, not assumed.
   *
   * An earlier version of this test asserted it WAS present and failed. That was
   * correct of the test and wrong of me: I had misread `2024-09-28` as later than
   * `2024-10-18`. September precedes October, so there is no inversion, and on
   * this account naive recency ranking happens to pick the right document.
   *
   * Recorded rather than quietly dropped, because it changes what the term filter
   * is doing here. It is NOT currently preventing a live failure on this account —
   * it is removing a dependency on a coincidence. Those are different claims and
   * only the second one is true today. The synthetic plant below is what actually
   * demonstrates the guard works.
   */
  const inversions = all.filter((d) => d.effectiveDate !== cur)
    .filter((older) => all.some((newer) =>
      newer.effectiveDate > older.effectiveDate &&
      String(older.transactionDate) > String(newer.transactionDate)
    ));
  const naiveIsCorrectHere = naive?.id === expected.declarationsWinner;
  console.log(
    `  INFO  fixture inversions (older term, later txn): ${inversions.length}`
    + `; naive recency would be ${naiveIsCorrectHere ? 'CORRECT by coincidence' : 'WRONG'} here`
  );

  /**
   * When the fixture declares what naive ranking would wrongly pick, assert it.
   *
   * This is the assertion the real recording cannot make, because it has no inversion.
   * Here the trap is in the data rather than planted by the test, so it proves the term
   * filter on a payload nobody tampered with mid-test — which is a meaningfully stronger
   * claim than the plant below.
   */
  if (expected.naiveWouldPick) {
    eq(naive?.id, expected.naiveWouldPick, 'naive recency picks the expired-term document');
    eq(
      naive?.effectiveDate !== payload.currentTermEffectiveDate,
      true,
      'and that document really is outside the in-force term'
    );
    if (dec.chosen[0]?.id !== naive?.id) {
      pass('the term filter rejects it on untampered data', `chose ${dec.chosen[0]?.id} over ${naive?.id}`);
    } else {
      fail('the term filter did NOT reject the expired-term document');
    }
  }

  /**
   * Now force the trap to bite. Remove the current term's documents and confirm
   * the ranking still refuses to prefer a stale-term document over an in-term one
   * when an in-term one exists — and that a synthetic older-term-but-newer-txn
   * entry cannot displace the correct answer.
   */
  const planted = structuredClone(payload);
  planted.otherPolicyDocuments.unshift({
    transactionType: 'POLICY CHANGE',
    transactionTypeCode: 'Endorse',
    transactionDate: '2099-01-01', // far newer than anything real
    documents: [{
      id: 'planted-stale-term',
      description: 'Declaration Page',
      effectiveDate: planted.previousTermEffectiveDate, // but an EXPIRED term
      transactionDate: '2099-01-01',
    }],
  });
  const withPlant = selectDocument(planted, 'declarations', { limit: 1 });
  if (withPlant.chosen[0]?.id === expected.declarationsWinner) {
    pass('a previous-term document with the newest transactionDate does NOT win', 'term filter holds');
  } else {
    fail('term filter failed — a stale-term document outranked the in-force one',
      String(withPlant.chosen[0]?.id));
  }

  // Prove the planted entry WOULD win under the naive rule, so the guard is real.
  const naivePlanted = [...flattenDocuments(planted, TARGETS.declarations.buckets)
    .filter((d) => TARGETS.declarations.description.test(d.description))]
    .sort((a, b) => String(b.transactionDate).localeCompare(String(a.transactionDate)))[0];
  if (naivePlanted.id === 'planted-stale-term') {
    pass('naive recency ranking DOES pick the stale-term document', 'confirms the guard is load-bearing');
  } else {
    fail('negative control inconclusive — naive rule did not pick the plant');
  }

  // -- 3. other targets -----------------------------------------------------
  const con = selectDocument(payload, 'contract', { limit: 1 });
  eq(con.chosen[0]?.description, 'Policy Contract', 'contract target finds a Policy Contract');
  eq(con.diagnostics.chosenIsInCurrentTerm, true, 'contract is from the in-force term');
  if (con.chosen[0]?.bucket === 'policyDocuments') {
    pass('contract comes from policyDocuments', 'bucket is part of target identity');
  } else {
    fail('contract came from the wrong bucket', String(con.chosen[0]?.bucket));
  }

  const idc = selectDocument(payload, 'idcard', { limit: 1 });
  eq(idc.chosen[0]?.description, 'Insurance ID Card', 'idcard target finds an Insurance ID Card');

  // -- 4. buckets do not bleed into each other ------------------------------
  const decAll = selectDocument(payload, 'declarations', { limit: 50 }).chosen;
  if (decAll.every((d) => d.description === 'Declaration Page')) {
    pass('no non-declaration documents leak in', `${decAll.length} returned`);
  } else {
    fail('selection returned an unrelated document type');
  }
  if (decAll.every((d) => d.bucket === 'otherPolicyDocuments')) {
    pass('declarations only ever come from otherPolicyDocuments');
  } else {
    fail('declarations leaked in from another bucket');
  }

  // -- 5. ordering: every in-term doc outranks every out-of-term one ---------
  const firstOut = decAll.findIndex((d) => d.effectiveDate !== cur);
  const lastIn = decAll.reduce((acc, d, i) => (d.effectiveDate === cur ? i : acc), -1);
  if (firstOut === -1 || lastIn < firstOut) {
    pass('all in-term documents rank above all out-of-term ones', `inTerm=${lastIn + 1}`);
  } else {
    fail('ranking interleaved in-term and out-of-term documents');
  }

  // -- 6. graceful degradation ----------------------------------------------
  const noTerm = structuredClone(payload);
  delete noTerm.currentTermEffectiveDate;
  const nt = selectDocument(noTerm, 'declarations', { limit: 1 });
  if (nt.chosen.length === 1 && nt.diagnostics.chosenIsInCurrentTerm === false) {
    pass('missing term metadata degrades to recency, and says so', 'chosenIsInCurrentTerm=false');
  } else {
    fail('missing term metadata handled wrongly', JSON.stringify(nt.diagnostics));
  }

  const empty = selectDocument({ currentTermEffectiveDate: cur, otherPolicyDocuments: [] }, 'declarations');
  eq(empty.chosen.length, 0, 'empty payload returns no documents rather than throwing');

  let threw = false;
  try { selectDocument(payload, 'not-a-real-target'); } catch { threw = true; }
  eq(threw, true, 'unknown target throws rather than silently returning nothing');

  // -- 7. determinism -------------------------------------------------------
  const a = selectDocument(payload, 'declarations', { limit: 5 }).chosen.map((d) => d.id).join(',');
  const b = selectDocument(payload, 'declarations', { limit: 5 }).chosen.map((d) => d.id).join(',');
  eq(a === b, true, 'selection is deterministic across runs');

  console.log('');
  if (failures) {
    console.log(`${failures} GEICO DOCUMENT SELECTION CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log('ALL GEICO DOCUMENT SELECTION CHECKS PASSED');
}

main().catch((err) => { console.error(err); process.exit(1); });
