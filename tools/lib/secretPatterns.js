/**
 * Secret-detection patterns, shared by the audit and its own test.
 *
 * Extracted into a module because `audit-secrets.js` has top-level `await` and calls
 * `process.exit()`, so importing it would run the audit rather than read its rules.
 * The test needs the real patterns, not a copy — a copy is how a guard ends up
 * passing while the thing it guards has drifted.
 *
 * This split was forced by a concrete failure: the first attempt at that test parsed
 * regex literals out of the source with a regex, and broke on the `/` inside
 * `[A-Za-z0-9%._~+/-]`. Parsing code with patterns is the wrong tool; exporting the
 * values is the right one.
 */

export const PATTERNS = [
  { name: 'JWT (3-segment)', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/, severity: 'high' },
  { name: 'JWT fragment', re: /\beyJ[A-Za-z0-9_-]{24,}/, severity: 'high' },
  { name: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/, severity: 'high' },
  { name: 'OAuth token param', re: /(?:access_token|id_token|refresh_token)=[A-Za-z0-9._-]{12,}/, severity: 'high' },

  /**
   * Session token carried in a URL query string.
   *
   * Added after this audit PASSED on a flow recording that contained a live
   * 48-character GEICO session token in `?token=…`. Every existing rule looked at
   * JSON field names, header values, or recognisable token *formats* — none
   * looked at URLs, so a credential sitting in a query string was invisible to
   * all of them.
   *
   * GEICO's own Quantum Digital masking rewrites that same parameter as
   * `token=*****` 154 times in the same recording, which is the carrier telling
   * us plainly that they consider it sensitive.
   *
   * URL-borne tokens matter more than their length suggests: they land in server
   * access logs, `Referer` headers sent to third parties, and browser history —
   * so they leak to places a cookie never reaches.
   *
   * Group 1 is the value, so an already-masked `token=*****` is distinguishable
   * from a real one rather than the rule firing on its own redaction marker
   * (the F-25 mistake).
   */
  {
    name: 'session token in URL',
    re: /[?&](?:token|convToken|sid|ssoToken|authToken|sessionId)=([A-Za-z0-9%._~+/-]{16,})/i,
    severity: 'high',
    captureGroup: 1,
  },
  {
    name: 'password JSON field',
    re: /"(?:password|pwd|secret|otp|mfaCode)"\s*:\s*"([^"]{3,})"/,
    severity: 'high',
    // Group 1 is the value, so a redaction marker can be distinguished from a
    // real secret rather than the whole field being treated as suspicious.
    captureGroup: 1,
  },
  { name: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/, severity: 'high' },

  /**
   * Vehicle Identification Number.
   *
   * Added after a GEICO flow recording was found to contain a real VIN, make,
   * model and lienholder. Not a credential, so it does not fail the audit — but
   * it is personal data about a specific vehicle and person, and these artefacts
   * exist expressly to be shared and committed.
   *
   * The 17-character format excludes I, O and Q by standard, which is what keeps
   * this from firing on ordinary base64 and hex blobs. Reported as a `note` so it
   * is surfaced on every run without training anyone to ignore a red FAIL they
   * cannot act on.
   */
  {
    name: 'VIN (vehicle ID)',
    re: /\b[A-HJ-NPR-Z0-9]{17}\b/,
    severity: 'note',
  },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, severity: 'high' },
  { name: 'long hex secret (>=40)', re: /\b[A-Fa-f0-9]{40,}\b/, severity: 'note' },
];

export const REDACTION_MARKERS = [
  /^<redacted(?::[a-z]+)?(?:\s+len\d+)?>$/i,
  /^<redacted len\d+>$/i,
  /^<jwt(?:-redacted)?>$/i,
  /^<email>$/i,
  /^<ssn>$/i,
  /^<long-number>$/i,
  /^<hex-redacted>$/i,
  /^Bearer <redacted>$/i,
  /^\[Redacted\]$/i,

  /**
   * The markers written by GEICO URL scrubbing, in both plain and URL-encoded form.
   *
   * ------------------------------------------------------------------------
   * THIS IS F-25 REPEATING, IN THE RULE ADDED TO AVOID F-25
   * ------------------------------------------------------------------------
   * The `session token in URL` rule matches `[A-Za-z0-9%._~+/-]{16,}` after
   * `token=`. `scrubUrl()` replaces a token with `[REDACTED 44 chars]`, which inside
   * a URL is percent-encoded to `%5BREDACTED+44+chars%5D` — and `%`, `+` and `-` are
   * all in that character class. So the audit flagged **its own redaction marker** as
   * a high-severity leak.
   *
   * `captureGroup: 1` was added to this rule precisely so a marker could be
   * distinguished from a real secret, and it was not enough: the group still captures
   * the encoded marker. The lesson is narrow and worth stating — a `captureGroup`
   * only helps if the marker is also *recognised*, and a marker that travels through
   * URL encoding needs its encoded form listed too.
   *
   * The cost of getting this wrong is not a false alarm, it is a true one being
   * ignored: an audit that fails on every run stops being read.
   */
  /^\[REDACTED[^\]]*\]$/i,
  /^%5BREDACTED[^%]*%5D$/i,
  /^%5BRED[A-Za-z0-9%+._-]*$/i,
  /^\*{3,}$/,
];


export default { PATTERNS, REDACTION_MARKERS };
