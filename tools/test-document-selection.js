/**
 * Unit tests for Progressive document selection, run against the real captured
 * payload shape.
 *
 * Exists because of F-28: the adapter returned three documents titled identically
 * `Declarations Page`, one of which came from a *lapsed* policy, and could not
 * distinguish two same-day copies within the live policy. That class of bug is
 * invisible to an end-to-end test — the run succeeds, the PDFs are valid, they
 * are simply the wrong ones — and each end-to-end attempt costs a real login and
 * a real SMS. So selection is tested in isolation, with no browser and no network.
 *
 * The fixture mirrors the structure captured in
 * artifacts/recordings/progressive/documents-structure.json:
 *   WA-AA — active   (terms.documentTerms populated, messageKey 'Standard')
 *   CA-AA — inactive (documentTerms: [], messageKey 'Readonly')
 *
 *   node tools/test-document-selection.js
 */

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** Real shape, trimmed to the fields selection reads. */
const payload = {
  accountDocuments: [
    {
      policyNumber: '879390482',
      isEligibleForDecPreview: true,
      actions: [
        { actionType: 'Detail', httpMethod: 'POST', serviceEndpointUrl: 'v1/policies/{policyNumber}/document' },
      ],
      terms: [
        {
          documentType: 'Declarations',
          documentTerms: [
            {
              effectiveDate: '2026-09-02T00:00:00.0000000-04:00',
              expirationDate: '2027-03-02T00:00:00.0000000-05:00',
              isEligibleForRealTimeDocument: true,
            },
          ],
          messageKey: 'Standard',
          message: '',
        },
      ],
      documents: [
        { type: 'DECPAGE', title: 'Declarations Page', index: 25, archiveDate: '2026-09-02', categories: ['All', 'DecPage'], _links: { target: { href: '/v1/policies/879390482/documents/Archive/25?policyInfoKey=WA-AA' } } },
        { type: 'DECPAGE', title: 'Declarations Page', index: 22, archiveDate: '2026-09-02', categories: ['All', 'DecPage'], _links: { target: { href: '/v1/policies/879390482/documents/Archive/22?policyInfoKey=WA-AA' } } },
        { type: 'POLICYCONTRACT', title: 'Policy Contract - 9611 (07/16)', index: 30, archiveDate: '2016-08-31', categories: ['All', 'Contract'], _links: { target: { href: '/v1/policies/879390482/documents/Archive/30?policyInfoKey=WA-AA' } } },
        { type: 'POLICYCONTRACTEASIER', title: 'Your Auto Policy: Easier - Z196 (02/06)', index: 31, archiveDate: '2010-08-05', categories: ['All', 'Contract'], _links: { target: { href: '/v1/policies/879390482/documents/Archive/31?policyInfoKey=WA-AA' } } },
        { type: 'BILLSTMT', title: 'Billing Statement', index: 40, archiveDate: '2026-09-10', categories: ['All', 'Billing'], _links: { target: { href: '/x' } } },
      ],
    },
    {
      policyNumber: '944210773',
      isEligibleForDecPreview: false,
      actions: [],
      terms: [
        {
          documentType: 'Declarations',
          documentTerms: [],
          messageKey: 'Readonly',
          message: "This policy isn't active, so a current Declarations Page isn't available.",
        },
      ],
      documents: [
        { type: 'DECPAGE', title: 'Declarations Page', index: 8, archiveDate: '2026-08-03', categories: ['All', 'DecPage'], _links: { target: { href: '/v1/policies/944210773/documents/Archive/8?policyInfoKey=CA-AA' } } },
        { type: 'POLICYCONTRACT', title: 'Policy Contract - 9611 (09/16)', index: 38, archiveDate: '2017-04-27', categories: ['All', 'Contract'], _links: { target: { href: '/v1/policies/944210773/documents/Archive/38?policyInfoKey=CA-AA' } } },
      ],
    },
  ],
};

/**
 * Exercise the adapter's real private method by constructing an instance with
 * stub collaborators. Testing the actual code beats re-implementing its logic in
 * the test, which would only prove the copy agrees with itself.
 */
const { ProgressiveCarrier } = await import('../src/carriers/progressive.js');

const logged = [];
const stubLog = {
  child: () => stubLog,
  info: (o) => logged.push(o),
  warn: (o) => logged.push(o),
  error: () => {},
  debug: () => {},
};

const carrier = new ProgressiveCarrier({
  page: { url: () => 'https://policyservicing.apps.progressive.com/app/account-home' },
  context: {},
  timings: { measure: async (_n, fn) => fn() },
  log: stubLog,
  notify: () => {},
});

/**
 * Overrides are passed explicitly rather than through environment variables:
 * `config` is frozen at import time, so mutating `process.env` between cases
 * would silently have no effect and every case would test the same target.
 */
async function select({ target, limit }) {
  const picked = carrier.selectDocumentsForTest(payload, { targetKey: target, limit });
  return { picked, logged };
}

console.log('Progressive document selection\n');

// --- contract target -------------------------------------------------------
{
  const { picked } = await select({ target: 'contract', limit: 1 });
  check('contract target returns exactly one document', picked.length === 1, `${picked.length}`);

  const [top] = picked;
  check('picks a Contract-category document', top?.kind === 'policy_contract', top?.kind);
  check(
    'picks POLICYCONTRACT, not the older EASIER booklet',
    top?.type === 'POLICYCONTRACT',
    top?.type
  );
  check(
    'picks the ACTIVE policy contract (WA index 30), not the lapsed one (CA index 38)',
    top?.index === 30 && top?.policyActive === true,
    `index=${top?.index} policyNumber=…${String(top?.policyNumber).slice(-4)} active=${top?.policyActive}`
  );
  check(
    'carries the term period for labelling',
    Boolean(top?.termEffective) && Boolean(top?.termExpiration),
    `${top?.termEffective?.slice(0, 10)} → ${top?.termExpiration?.slice(0, 10)}`
  );
  check(
    'does not return declarations or billing documents',
    !picked.some((p) => p.kind !== 'policy_contract')
  );
}

// --- the lapsed-policy trap that caused F-28 --------------------------------
{
  const { picked } = await select({ target: 'contract', limit: 10 });
  check(
    'with a high limit, every active-policy contract ranks above every lapsed one',
    (() => {
      const firstLapsed = picked.findIndex((p) => !p.policyActive);
      const lastActive = picked.map((p) => p.policyActive).lastIndexOf(true);
      return firstLapsed === -1 || firstLapsed > lastActive;
    })(),
    picked.map((p) => `${p.type}#${p.index}${p.policyActive ? '' : '(lapsed)'}`).join(' ')
  );
  check(
    'the CA-AA contract is reachable but ranked last',
    picked.some((p) => p.index === 38 && p.policyActive === false)
  );
  check(
    'newer archiveDate wins within the same type and policy status',
    (() => {
      const active = picked.filter((p) => p.policyActive && p.type === 'POLICYCONTRACT');
      return active.every(
        (p, i) => i === 0 || Date.parse(active[i - 1].archiveDate) >= Date.parse(p.archiveDate)
      );
    })()
  );
}

// --- declarations target still works ---------------------------------------
{
  const { picked } = await select({ target: 'declarations', limit: 1 });
  const [top] = picked;
  check('declarations target still selectable', top?.kind === 'declarations', top?.kind);
  check(
    'declarations picks the ACTIVE policy, not CA-AA index 8',
    top?.policyActive === true && top?.index !== 8,
    `index=${top?.index} active=${top?.policyActive}`
  );
}

// --- a target the account has nothing for ----------------------------------
{
  const { picked } = await select({ target: 'idcard', limit: 1 });
  check('target with no matching documents returns empty', picked.length === 0, `${picked.length}`);
}

// --- determinism ------------------------------------------------------------
{
  const a = await select({ target: 'contract', limit: 5 });
  const b = await select({ target: 'contract', limit: 5 });
  const key = (r) => r.picked.map((p) => `${p.type}#${p.index}`).join(',');
  check('selection is deterministic across runs', key(a) === key(b), key(a));
}

console.log(
  `\n${failures === 0 ? 'ALL DOCUMENT SELECTION CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`
);
process.exit(failures === 0 ? 0 : 1);
