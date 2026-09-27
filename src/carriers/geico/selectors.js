/**
 * GEICO selectors, with provenance.
 *
 * ------------------------------------------------------------------------
 * ISOLATION CONTRACT (read before editing anything in this directory)
 * ------------------------------------------------------------------------
 * Everything under src/carriers/geico/ is deliberately self-contained:
 *
 *   ALLOWED    extend BaseCarrier; import config, logger, and the shared
 *              primitives on BaseCarrier (raceOutcomes, firstVisible,
 *              typeLikeHuman, assertNotBlocked)
 *   FORBIDDEN  importing anything from ../progressive.js
 *   FORBIDDEN  editing ../baseCarrier.js to suit GEICO
 *
 * If a shared primitive needs to behave differently for GEICO, override it as a
 * method on GeicoCarrier. Do not change the base.
 *
 * The reason is a deliberate tradeoff, not laziness: the Progressive path is
 * verified working end-to-end against a real account, and it is worth more than
 * the handful of lines a shared helper would save. Duplication between the two
 * adapters is accepted so that GEICO work cannot regress Progressive.
 * ------------------------------------------------------------------------
 *
 * WHY EVERY SELECTOR HERE CARRIES A PROVENANCE NOTE
 *
 * GEICO's login is a Flutter Web app, and Flutter produces two distinct traps
 * that both yield selectors which *appear* perfect in devtools and then fail in
 * production. Both were hit during recon (F-32):
 *
 *   1. Authored ids materialise only on focus. `#username` and
 *      `#current-password` do not exist until focus enters the field, because
 *      Flutter does not build a real accessible DOM until it believes assistive
 *      technology is present. Anything you read out of devtools *after clicking
 *      the field* is a mirage — automation arrives before any focus event.
 *
 *   2. Semantics-node ids are assigned in mount order. The "Log In" button was
 *      `flt-semantic-node-37` on one page load and `flt-semantic-node-16` on the
 *      next. Identical trap to Progressive's minted input ids (F-08), now
 *      confirmed on a second carrier and a second framework.
 *
 * So each entry records which probe verified it and how. A selector without
 * provenance is a guess, and guesses in this file cost a real login to disprove.
 */

/** Online Service Center. Documents live behind this host too. */
export const LOGIN_URL = 'https://ecams.geico.com/login';

/**
 * Dead ends, recorded so nobody re-tries them:
 *   login.geico.com   -> ERR_NAME_NOT_RESOLVED (does not exist)
 *   www.geico.com     -> no password field anywhere, 4 iframes, not Flutter
 */
export const KNOWN_DEAD_ENTRY_POINTS = Object.freeze([
  'https://login.geico.com/',
  'https://www.geico.com/',
]);

/**
 * Credential fields.
 *
 * VERIFIED by tools/geico/probe-geico-typing.js: typed into both and read the
 * value back. Read-back matters — `type()` resolving is not evidence the field
 * holds the text, and O-5 found an action in this codebase that appeared to
 * succeed for the project's entire history while silently doing nothing.
 *
 * Both are present WITHOUT any focus, straight after mount, which is what makes
 * them usable. Measured: username ~686-715ms, password ~447-524ms.
 */
export const CREDENTIALS = Object.freeze({
  /** `autocomplete="email"` is authored by GEICO and stable pre-focus. */
  username: 'input[autocomplete="email"]',
  password: 'input[type="password"]',

  /**
   * Fallback pair, independently verified by the same probe. Keyed on Flutter's
   * own semantics attribute. Kept because it fails for different reasons than
   * the primary pair: if GEICO changes `autocomplete`, this survives, and vice
   * versa.
   */
  usernameFallback: 'input[data-semantics-role="text-field"][type="text"]',
  passwordFallback: 'input[data-semantics-role="text-field"][type="password"]',
});

/**
 * DO NOT USE — recorded so the trap is visible rather than rediscovered.
 *
 * These look like the best selectors on the page and are the worst. Probed
 * result: `#username` count stayed at **0** even after clicking the password
 * shell to force materialisation, while `#current-password` reached 1. A
 * strategy built on them failed outright.
 */
export const DO_NOT_USE = Object.freeze({
  username: '#username',
  password: '#current-password',
  reason: 'Flutter materialises authored ids only on focus, and inconsistently. '
    + 'Verified non-viable in probe-geico-typing.js strategy 2.',
});

/**
 * Flutter renders buttons as semantics nodes, not `<button>`.
 *
 * Matched on TEXT, never on id. `flt-semantic-node-N` is mount-order-assigned
 * and was observed changing between two consecutive loads of the same page.
 */
export const BUTTON_TEXT = Object.freeze({
  login: /^log in$/i,
  /**
   * A separate passkey path exists alongside the password form
   * ("Log In with Existing Passkey"). Anchored with `^...$` above so the login
   * matcher cannot accidentally select it — a substring match on "log in" would
   * hit both, and clicking the passkey button would open a WebAuthn prompt that
   * nothing can satisfy.
   */
  passkey: /passkey/i,
});

/** Any Flutter button, to be filtered by accessible text. */
export const FLUTTER_BUTTON = 'flt-semantics[role="button"]';

/**
 * Flutter app-shell markers, used to tell "not mounted yet" from "not there".
 *
 * This distinction is the entire reason GEICO was wrongly ruled out: the form
 * takes 2.3-6.2s to appear behind an Imperva challenge, and a single DOM sample
 * before that reports an empty page indistinguishable from a hard block.
 */
export const FLUTTER = Object.freeze({
  glassPane: 'flt-glass-pane, flutter-view',
  semanticsNode: 'flt-semantics',
  /**
   * Absent on this page. The commonly-cited "click flt-semantics-placeholder to
   * enable accessibility" technique does not apply to GEICO — tested and dead.
   * Kept as a named constant so a future reader knows it was checked.
   */
  semanticsPlaceholder: 'flt-semantics-placeholder',
});

/** OneTrust consent banner. Dismissed defensively; may not appear. */
export const COOKIE_BANNER = Object.freeze({
  reject: '#onetrust-reject-all-handler',
  accept: '#onetrust-accept-btn-handler',
  container: '#onetrust-banner-sdk',
});

/**
 * Routes and web-service endpoints, VERIFIED from a real recorded session
 * (`artifacts/recordings/geico/events.jsonl`, 12 navigations / 256 responses).
 *
 * This is the most valuable thing the recording produced, and it changes the
 * adapter's strategy: GEICO's Flutter app talks to a clean JSON API, so the flow
 * can be driven by the DOM while *state is read from the network*. That is the
 * same approach that made the Progressive adapter tractable — the app does the
 * auth work, we harvest the result — and it is far more robust than scraping a
 * Flutter semantics tree.
 *
 * Note the three-host journey. Nothing in the public documentation suggests it,
 * and an adapter that assumed one origin would break at the first hop:
 *
 *   ecams.geico.com         login + 2SV
 *   portfolio.geico.com     post-auth dashboard
 *   edgecustomer.geico.com  documents
 */
export const ROUTES = Object.freeze({
  login: '/login',
  mfaOptions: '/mfa/options',
  mfaPin: '/mfa/pin',
  dashboard: '/dashboard',
  documentsHome: '/documents/proof-of-insurance-home',
  /**
   * The real document list page. Reached in the recorded session via /view-policy,
   * but navigable directly: the app adds ?token=&visitAppId= itself after bootstrap.
   */
  documentsList: '/documents/consolidated-documents',
  /**
   * Intermediate page the captured manual session passed through on its way to the
   * document list. Kept as a fallback route: it may establish state the list page
   * assumes, and following the observed path is cheaper than deducing why.
   */
  viewPolicy: '/view-policy',
  documentViewer: '/documents/consolidated-document-viewer',
  declarationSend: '/documents/declaration-page-send',
});

export const HOSTS = Object.freeze({
  auth: 'ecams.geico.com',
  portfolio: 'portfolio.geico.com',
  documents: 'edgecustomer.geico.com',
});

/**
 * JSON endpoints observed. Responses share an envelope:
 *   { _payload: …, _flags: { … }, _messages: [ … ] }
 *
 * `_flags` is a large feature-flag map and is genuinely useful — it is how the
 * app decides which document affordances to render, so it answers questions about
 * capability that the DOM only implies.
 */
export const ENDPOINTS = Object.freeze({
  loginInit: '/ws/login/init',
  authenticate: '/ws/login/authenticate',
  /** Returns the real 2SV destinations; see MFA.optionsShape below. */
  mfaOptions: '/ws/mfa/options',
  otpSend: '/ws/mfa/otp/send',
  /** Reports which channel was actually used, e.g. `mfaVerificationType: "TextMessage"`. */
  otpInit: '/ws/mfa/otp/init',
  otpAuthenticate: '/ws/mfa/otp/authenticate',
  /** ID cards and proof of insurance. NOT where the declarations page lives. */
  proofOfInsurance: '/ws/proof-of-insurance',

  /**
   * THE DOCUMENT LIST. Returns every document with GEICO's own taxonomy plus the
   * term metadata that makes correct selection possible, and the opaque
   * `policyNumber` that doubles as the `view-document` token.
   */
  consolidatedDocuments: '/ws/consolidated-documents',

  /** THE DOCUMENT BYTES. Verified: 200, application/pdf, 52,361 bytes, `%PDF-`. */
  viewDocument: '/ws/consolidated-documents/view-document',

  /** Precedes view-document in the UI flow; returns no body of its own. */
  previewDocument: '/ws/consolidated-documents/preview-document',

  /**
   * Returns `_payload: true` — a confirmation that an email was sent, NOT a PDF.
   * Treating its 200 as success would report a completed pull having fetched
   * nothing. See F-35/F-37.
   */
  submitPolicyDocument: '/ws/consolidated-documents/submit-policy-document',
});

/**
 * 2-Step Verification — now VERIFIED against a real session.
 *
 * The DOM selectors below remain ordered candidate lists, but they are no longer
 * the primary strategy. `GET /ws/mfa/options` returns the delivery methods
 * directly, which is strictly better than reading a Flutter semantics tree:
 *
 *   {
 *     "_payload": {
 *       "emails":       [{ "label": "rc***@gmail.com",  "value": "<uuid>" }],
 *       "phoneNumbers": [{ "label": "(XXX)XXX-5116",    "value": "<uuid>" }]
 *     },
 *     "_flags": { "SHOW_PASSKEY": …, "RECOVERY_SMS": false, … }
 *   }
 *
 * Two things worth noting. GEICO pre-masks the labels itself, so they are safe to
 * show a user and safe to log — which is unusually considerate and means the
 * adapter can name the destination without handling the raw address. And the
 * `value` is an opaque UUID, so selecting a channel never requires holding the
 * phone number or email.
 *
 * Confirms F-33 on both counts: the chooser is a real, separate screen
 * (`/mfa/options` → `/mfa/pin`), and nothing in either payload offers a
 * trusted-device option.
 */
export const MFA_API = Object.freeze({
  optionsShape: {
    emailsPath: '_payload.emails',
    phonesPath: '_payload.phoneNumbers',
    labelKey: 'label',
    valueKey: 'value',
  },
  /** Channel actually used, read back from `/ws/mfa/otp/init`. */
  verificationTypePath: '_payload.mfaVerificationType',
  knownVerificationTypes: ['TextMessage', 'Email'],
});

/**
 * DOM fallbacks for the 2SV screens.
 *
 * Kept as ordered lists so `firstVisible()` fails with a clear SELECTOR_DRIFT
 * error rather than timing out, and kept at all because reading the API tells us
 * *what* the options are but the code still has to be typed into a real field.
 */
export const MFA = Object.freeze({
  /**
   * The verification-code field. VERIFIED from recorded snapshots of `/mfa/pin`.
   *
   * ------------------------------------------------------------------------
   * THIS FIELD SWAPS ITS ATTRIBUTES WHEN FOCUSED — the selector must survive it
   * ------------------------------------------------------------------------
   * Observed across five consecutive snapshots of the same screen:
   *
   *   snapshots 1-3 (before focus)  id=None             aria-label="Verification code"
   *   snapshots 4-5 (after focus)   id="one-time-code"  aria-label=None
   *
   * Same element. Flutter materialises the authored id on focus and drops the
   * aria-label doing it — the F-32 pattern again, but with a sharper edge here.
   *
   * The edge: Playwright re-resolves a locator on EVERY action. So a locator keyed
   * on `[aria-label="Verification code"]` would click successfully, the attribute
   * would then disappear, and the very next `press()` would re-resolve against a
   * selector matching nothing and time out **mid-typing** — after the code had been
   * partially entered. That failure would look like a carrier problem and would be
   * miserable to diagnose.
   *
   * So the primary selector is `data-semantics-role="text-field"`, the only
   * attribute present in BOTH states. The OR-form covers the field in either state
   * regardless of when we arrive.
   *
   * Every one of the four selectors guessed before this recording was wrong:
   * `autocomplete` is `off` (not `one-time-code`), there is no `inputmode`, and the
   * type is `text` (not `tel`).
   */
  codeInput: [
    'input[data-semantics-role="text-field"]',
    '#one-time-code',
    'input[name="one-time-code"]',
    'input[aria-label="Verification code"]',
  ],

  /**
   * Submit button text. VERIFIED: the label is **"Submit Code"**, not "Submit".
   *
   * The previous pattern was `/^(submit|verify|continue|next)$/i`, anchored at both
   * ends, which does not match "Submit Code". Ordered longest-first so the specific
   * label wins before the generic fallbacks are tried.
   */
  submitText: [/^submit code$/i, /^(submit|verify|continue|next)$/i],

  /**
   * Resend affordance, captured because its label embeds a live countdown —
   * "Resend Code In 60 Seconds", "…59 Seconds", "…56 Seconds". Recorded so nobody
   * writes an exact-match selector against a string that changes every second.
   */
  resendText: /^resend code in \d+ seconds?$/i,

  /**
   * Delivery-method chooser at `/mfa/options`. PARTIALLY verified.
   *
   * What the recording proves: the screen has exactly two controls, **"Cancel"**
   * and **"Next"**, and no visible inputs, no `<select>`, no `[role=listbox]`, and
   * no list rows the snapshot could see.
   *
   * What it does NOT show: how the email/phone choices are rendered. They are not
   * buttons, so the earlier plan — click a button whose label says "text" or
   * "email" — cannot work. They are most likely radio-style semantics nodes that
   * the structure snapshot did not collect.
   *
   * So the adapter tries to select the preferred channel by matching GEICO's own
   * masked labels (`rc***@gmail.com`, `(XXX)XXX-5116`, shapes confirmed from
   * `/ws/mfa/options`), and if it cannot find one it clicks "Next" with whatever
   * GEICO pre-selected and says so in the log. Failing closed here would be worse
   * than proceeding: a default of "text to the phone on file" is almost always what
   * the user wants, and the run is observable either way.
   */
  chooserAdvanceText: [/^next$/i],
  chooserCancelText: [/^cancel$/i],
  /** Shapes GEICO uses for masked destinations, for matching a chooser option. */
  maskedDestination: Object.freeze({
    email: /[a-z0-9]{1,4}\*{2,}@/i,
    sms: /\(?x{3}\)?[\s-]?x{3}[\s-]?\d{4}/i,
  }),

  /** Phrases indicating the code was rejected. */
  rejectionText: [
    /incorrect|invalid|not match|try again|didn.t work|wasn.t recognized/i,
  ],
});

/**
 * Evidence of a failed credential submit, as opposed to a slow one.
 *
 * Without this, wrong credentials present as a 20s timeout and an error about
 * selectors, which points the next debugger at the wrong layer entirely.
 */
export const LOGIN_ERROR_TEXT = [
  /incorrect|invalid|does not match|unable to log ?you ?in|check your (user ?name|email)/i,
  /account (has been )?locked|temporarily (locked|disabled)/i,
];

/**
 * Document affordances on the documents page, VERIFIED from the recording.
 *
 * ------------------------------------------------------------------------
 * THE DISTINCTION THAT MATTERS
 * ------------------------------------------------------------------------
 * The documents page offers two different things, and only one of them is a
 * document:
 *
 *   "View Declaration Page"   -> renders/downloads the PDF        ← WHAT WE WANT
 *   "Submit" (on /documents/declaration-page-send)
 *                             -> EMAILS it, returns `_payload: true`
 *
 * The recorded walkthrough took the second path. `POST
 * /ws/consolidated-documents/submit-policy-document` answered with a bare boolean
 * — a confirmation that a message was sent, with no document anywhere in the
 * response.
 *
 * This is worth stating loudly because it is a trap an adapter would fall into
 * silently: the request succeeds, returns 200, and `_payload: true` reads as
 * success. An adapter that treated that as "document retrieved" would report a
 * completed pull having fetched nothing at all — the same class of failure as
 * F-28, where a confidently wrong document was worse than an honest error.
 *
 * `_flags.SHOW_CONSOLIDATED_DOCUMENT_PREVIEW: true` in that same response is the
 * app confirming a preview path exists. It has not been captured yet.
 */
export const DOCUMENT_ACTIONS = Object.freeze({
  /** The one we want. Verified present on /documents/proof-of-insurance-home. */
  viewDeclarationPage: /^view declaration page$/i,
  viewOrSendIdCard: /^view or send id card/i,
  requestMultiple: /^request multiple documents$/i,
  /**
   * DO NOT CLICK expecting a document. This is the email path.
   * Returns `_payload: true` and no PDF.
   */
  submitSend: /^submit$/i,
});

export default {
  LOGIN_URL,
  KNOWN_DEAD_ENTRY_POINTS,
  CREDENTIALS,
  DO_NOT_USE,
  BUTTON_TEXT,
  FLUTTER_BUTTON,
  FLUTTER,
  COOKIE_BANNER,
  MFA,
  MFA_API,
  ROUTES,
  HOSTS,
  ENDPOINTS,
  DOCUMENT_ACTIONS,
  LOGIN_ERROR_TEXT,
};
