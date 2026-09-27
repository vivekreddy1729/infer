/**
 * GEICO document selection and retrieval.
 *
 * ISOLATION: self-contained. Never imports from ../progressive.js. See the
 * contract in ./selectors.js.
 *
 * ------------------------------------------------------------------------
 * HOW THE REAL FLOW WORKS
 * ------------------------------------------------------------------------
 * Established from a recorded session (F-37). Three corrections to earlier
 * assumptions are baked in here, and each one had a cost:
 *
 * 1. The documents live at `/documents/consolidated-documents`, NOT
 *    `/documents/proof-of-insurance-home`. The latter is ID cards and proof of
 *    insurance — a different thing that looks like the right place.
 *
 * 2. `POST /ws/consolidated-documents/submit-policy-document` does NOT return a
 *    document. It returns `_payload: true`, meaning "we emailed it". Clicking that
 *    path and treating 200 + `true` as success would report a completed pull
 *    having fetched nothing.
 *
 * 3. `GET /ws/consolidated-documents/view-document` is the one that returns bytes.
 *    Verified: 200, `application/pdf`, 52,361 bytes, magic `%PDF-`.
 *
 * The list call gives everything needed, including the token:
 *
 *   GET /ws/consolidated-documents
 *   { "_payload": {
 *       "policyNumber": "<44-char opaque token>",
 *       "currentTermEffectiveDate":  "2026-09-17",
 *       "previousTermEffectiveDate": "2026-03-17",
 *       "policyDocuments":      [ { id, description, effectiveDate, transactionDate } ],
 *       "otherPolicyDocuments": [ { transactionType, transactionTypeCode,
 *                                   transactionDate, documents: [ … ] } ],
 *       "billingDocuments":     [ … ],
 *       "importantDocuments":   [ … ] } }
 *
 * `policyNumber` is the `token` query parameter for `view-document` — same
 * 44-character opaque value — so the adapter never has to scrape it out of a URL.
 */

import config from '../../config.js';
import { CarrierError, ErrorCodes } from '../baseCarrier.js';
import { HOSTS, ENDPOINTS } from './selectors.js';

/**
 * Which document each `DOCUMENT_TARGET` means, in GEICO's own vocabulary.
 *
 * This is the F-29 rule applied: use the carrier's taxonomy, never title text
 * matching or list position. GEICO's `description` field IS the taxonomy — it is
 * a closed vocabulary, not free-form copy. Observed values, with counts from one
 * real account:
 *
 *   policyDocuments        Policy Contract (11), Automobile Policy Amendment (4),
 *                          Signature Page (2)
 *   otherPolicyDocuments   Important Notice (12), Loss Payable Clause (12),
 *                          Declaration Page (11), Signature Page (10),
 *                          Insurance ID Card (9), Privacy Notice (8), …
 *
 * Note that **"Declaration Page" appears only in `otherPolicyDocuments`** and
 * "Policy Contract" only in `policyDocuments`, so the bucket is part of the
 * identity of a target rather than an implementation detail.
 */
export const TARGETS = Object.freeze({
  declarations: { buckets: ['otherPolicyDocuments'], description: /^declaration page$/i },
  contract: { buckets: ['policyDocuments'], description: /^policy contract$/i },
  idcard: { buckets: ['otherPolicyDocuments'], description: /^insurance id card$/i },
});

/**
 * Flatten the two payload shapes into one list.
 *
 * `policyDocuments` is a flat array of documents. `otherPolicyDocuments` and
 * `billingDocuments` are arrays of *transaction groups*, each wrapping a
 * `documents` array. The group carries `transactionType` / `transactionTypeCode`,
 * which `view-document` needs, so the group context has to be preserved rather
 * than flattened away.
 */
export function flattenDocuments(payload, buckets) {
  const out = [];
  for (const bucket of buckets) {
    const items = payload?.[bucket];
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      if (Array.isArray(item.documents)) {
        for (const d of item.documents) {
          out.push({
            ...d,
            bucket,
            transactionType: item.transactionType ?? null,
            transactionTypeCode: item.transactionTypeCode ?? null,
            groupTransactionDate: item.transactionDate ?? null,
          });
        }
      } else if (item.id) {
        out.push({ ...item, bucket, transactionType: null, transactionTypeCode: null, groupTransactionDate: item.transactionDate ?? null });
      }
    }
  }
  return out;
}

/**
 * Pick the right document.
 *
 * ------------------------------------------------------------------------
 * WHY THE TERM FILTER IS HERE — DO NOT REMOVE IT
 * ------------------------------------------------------------------------
 * Eleven documents on the recorded account are described "Declaration Page". Only
 * two belong to the in-force term. So *something* has to choose between them.
 *
 * Stated precisely, because an earlier draft of this comment overclaimed and the
 * distinction matters: on that account, ranking by `transactionDate` alone would
 * have picked the **correct** document, because the newest endorsement happens to
 * belong to the current term. Measured — zero cases where an older term carries a
 * later transaction date. So the term filter is not fixing a live failure here.
 *
 * What it does is remove the dependency on that coincidence, and there are three
 * concrete reasons that is worth doing rather than trusting recency:
 *
 *  1. **GEICO itself makes the distinction.** `view-document` takes
 *     `policyTerm=currentTerm|previousTerm`. Selecting a document without deciding
 *     which term it belongs to means guessing at a parameter the carrier requires.
 *  2. **F-28 is this exact failure on Progressive**, where a recency heuristic
 *     returned a declarations page from a *lapsed* policy because its archived
 *     copy carried a newer date — and the run reported success. Same shape,
 *     different carrier; the ordering there was simply unlucky.
 *  3. **Endorsements are backdated.** `transactionDate` is when paperwork was
 *     generated, `effectiveDate` is which term it governs. Nothing prevents a
 *     late-processed endorsement for an old term from being written after a new
 *     term begins, and on a renewal boundary that is a normal occurrence.
 *
 * So: filter to `effectiveDate === currentTermEffectiveDate` FIRST, then take the
 * latest `transactionDate` within that term, because the most recent endorsement
 * supersedes earlier ones for the same term.
 *
 * `npm run test:geico-docs` plants a previous-term document carrying the newest
 * transaction date and asserts it does NOT win — and separately asserts that naive
 * recency ranking DOES pick it, so the guard is demonstrated rather than asserted.
 */
export function selectDocument(payload, target = config.DOCUMENT_TARGET, { limit = config.DOCUMENT_LIMIT } = {}) {
  const spec = TARGETS[target];
  if (!spec) {
    throw new CarrierError(`unknown GEICO document target "${target}"`, {
      code: ErrorCodes.NO_DOCUMENTS,
      userMessage: `"${target}" is not a document type this adapter knows how to find.`,
    });
  }

  const currentTerm = payload?.currentTermEffectiveDate ?? null;
  const all = flattenDocuments(payload, spec.buckets);
  const matching = all.filter((d) => spec.description.test(String(d.description ?? '').trim()));

  if (!matching.length) {
    return { chosen: [], diagnostics: { target, currentTerm, totalInBuckets: all.length, matchingDescription: 0 } };
  }

  // Term partition. Kept separate rather than filtered away so the diagnostics
  // can report *why* a document was rejected, not just that it was.
  const inTerm = matching.filter((d) => currentTerm && d.effectiveDate === currentTerm);
  const outOfTerm = matching.filter((d) => !currentTerm || d.effectiveDate !== currentTerm);

  /**
   * Rank within the term: latest transaction first, then latest effective date.
   *
   * `localeCompare` on ISO-8601 dates is correct and avoids constructing Date
   * objects, which would introduce a timezone where none is wanted — these are
   * calendar dates, not instants.
   */
  const byRecency = (a, b) =>
    String(b.transactionDate ?? b.groupTransactionDate ?? '').localeCompare(String(a.transactionDate ?? a.groupTransactionDate ?? '')) ||
    String(b.effectiveDate ?? '').localeCompare(String(a.effectiveDate ?? ''));

  inTerm.sort(byRecency);
  outOfTerm.sort(byRecency);

  /**
   * In-term documents always outrank out-of-term ones, regardless of date.
   *
   * Out-of-term entries are appended rather than discarded so that a raised
   * `DOCUMENT_LIMIT` still returns something useful, and so an account whose
   * term metadata is missing degrades to recency-ranking instead of returning
   * nothing. They can never displace an in-term document.
   */
  const ranked = [...inTerm, ...outOfTerm];

  return {
    chosen: ranked.slice(0, limit),
    diagnostics: {
      target,
      currentTerm,
      totalInBuckets: all.length,
      matchingDescription: matching.length,
      inCurrentTerm: inTerm.length,
      outOfTerm: outOfTerm.length,
      chosenIsInCurrentTerm: ranked.length ? inTerm.includes(ranked[0]) : false,
    },
  };
}

/**
 * Fetch the document list through the authenticated context.
 *
 * Uses `context.request` rather than navigating, for the reason F-36 established:
 * `context.request` shares the context's cookies and returns bytes directly,
 * whereas a PDF navigated to in a tab is swallowed by Chrome's internal viewer and
 * never surfaces as a response.
 */
export async function fetchDocumentList(context, { log, headers } = {}) {
  const url = `https://${HOSTS.documents}${ENDPOINTS.consolidatedDocuments}`;
  /**
   * Replay the app's own headers when we have them.
   *
   * Cookies alone give a 401 here: the documents host wants `sessionkey`,
   * `edge-policy-token`, `x-xsrf-token` and a set of `asd-*` state headers that
   * `context.request` does not carry (F-10/F-11). Captured from an observed
   * authenticated request rather than reconstructed.
   */
  const res = await context.request.get(url, {
    timeout: config.DOCUMENT_TIMEOUT_MS,
    ...(headers ? { headers } : {}),
  });

  if (!res.ok()) {
    throw new CarrierError(`GEICO document list returned ${res.status()}`, {
      code: res.status() === 401 || res.status() === 403 ? ErrorCodes.NO_DOCUMENTS : ErrorCodes.NAVIGATION,
      userMessage: 'GEICO would not return the document list for this session.',
    });
  }

  const json = await res.json();
  const payload = json?._payload;
  if (!payload) {
    throw new CarrierError('GEICO document list had no _payload', {
      code: ErrorCodes.SELECTOR_DRIFT,
      userMessage: 'GEICO returned an unexpected response shape for the document list.',
    });
  }

  log?.info(
    {
      currentTerm: payload.currentTermEffectiveDate,
      policyDocuments: payload.policyDocuments?.length ?? 0,
      otherGroups: payload.otherPolicyDocuments?.length ?? 0,
      billingGroups: payload.billingDocuments?.length ?? 0,
    },
    'GEICO document list retrieved'
  );
  return payload;
}

/**
 * Download one document's bytes.
 *
 * The `token` is the opaque `policyNumber` from the list payload — a 44-character
 * value confirmed identical to the `token` query parameter the app itself sends.
 * It is credential-equivalent: it grants document access, and GEICO's own
 * session-replay masking rewrites it as `token=*****`. So it is never logged, and
 * `audit-secrets.js` has a `session token in URL` rule specifically because an
 * earlier artefact leaked one.
 */
export async function downloadDocument(context, payload, doc, { log, headers } = {}) {
  const params = new URLSearchParams({
    documentId: doc.id,
    token: payload.policyNumber,
    documentName: doc.description,
    policyTerm: doc.effectiveDate === payload.currentTermEffectiveDate ? 'currentTerm' : 'previousTerm',
  });
  // Only present on transaction-grouped documents; omitted rather than sent empty.
  if (doc.transactionTypeCode) params.set('transactionType', doc.transactionTypeCode);

  const url = `https://${HOSTS.documents}${ENDPOINTS.viewDocument}?${params.toString()}`;
  const res = await context.request.get(url, {
    timeout: config.DOCUMENT_TIMEOUT_MS,
    // Same reason as the list call: cookies are not sufficient on this host.
    ...(headers ? { headers } : {}),
  });

  if (!res.ok()) {
    throw new CarrierError(`GEICO view-document returned ${res.status()} for ${doc.description}`, {
      code: ErrorCodes.NO_DOCUMENTS,
      userMessage: 'GEICO would not release the document for this policy.',
    });
  }

  const bytes = await res.body();

  /**
   * Verify the magic bytes.
   *
   * F-13: a 200 with `content-type: application/pdf` is not evidence of a PDF.
   * A session-expired HTML page is routinely served with the wrong content-type,
   * and handing that to a PDF viewer produces a blank pane and a bug report about
   * the viewer. Checking five bytes eliminates the whole class.
   */
  const magic = bytes.subarray(0, 5).toString('latin1');
  if (!magic.startsWith('%PDF-')) {
    throw new CarrierError(
      `GEICO returned ${bytes.length} bytes that are not a PDF (magic ${JSON.stringify(magic)})`,
      {
        code: ErrorCodes.NO_DOCUMENTS,
        userMessage: 'GEICO returned something other than a PDF. The session may have expired.',
      }
    );
  }

  // Never the token, never the bytes.
  log?.info(
    { description: doc.description, documentId: doc.id, bytes: bytes.length, policyTerm: params.get('policyTerm') },
    'GEICO document downloaded'
  );

  return {
    name: `GEICO ${doc.description} ${doc.effectiveDate ?? ''}`.trim().replace(/\s+/g, ' '),
    mime: 'application/pdf',
    bytes,
    kind: doc.description,
    meta: {
      documentId: doc.id,
      description: doc.description,
      effectiveDate: doc.effectiveDate ?? null,
      transactionDate: doc.transactionDate ?? null,
      transactionType: doc.transactionType ?? null,
      policyTerm: params.get('policyTerm'),
      termEffectiveDate: payload.currentTermEffectiveDate ?? null,
      termExpirationDate: payload.currentTermExpirationDate ?? null,
    },
  };
}

export default { TARGETS, flattenDocuments, selectDocument, fetchDocumentList, downloadDocument };
