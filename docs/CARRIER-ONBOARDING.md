# Carrier Onboarding Playbook

How to add a new carrier adapter, derived from doing it for Progressive. Follow the order — it is
sequenced so the cheapest checks eliminate the most candidates, and so you never burn a real login
on an unanswered question.

Every step has a tool. None of them require credentials until step 4.

---

## Step 0 · Decide whether the carrier is worth attempting

**Do not pick carriers by brand recognition.** Pick by what the automation stack can actually
reach. That judgement is cheap to make and expensive to skip.

```bash
npm run recon          # HTTP-layer: which anti-bot vendor fronts each portal
npm run recon:deep     # headers, cookie names, external script hosts
```

Findings from the original survey:

| Carrier | Edge / bot layer | Verdict |
|---|---|---|
| Progressive | nginx + CloudFront, no bot cookies on the login shell | **implemented** |
| Travelers | F5 BIG-IP ASM (`TS*`) + Dynatrace, **Okta** IdP | **recommended next** |
| Hugo | CloudFront, nothing detected | viable, email-first multi-step |
| Lemonade | Cloudflare | viable, email-first, random input ids |
| GEICO | Imperva + Quantum Metric | **viable** — Flutter Web, late mount; earlier "avoid" was wrong, see F-32 |
| State Farm | Akamai — returns **503 to a plain curl** | avoid |
| Allstate, Nationwide | Akamai Bot Manager | avoid on a short clock |

**The HTTP layer is a poor predictor.** Run step 1 before trusting any of the above.

---

## Step 1 · Confirm the stack is served the real login form

```bash
node tools/probe-carrier.js https://carrier.example/login
node tools/probe-locators.js https://carrier.example/login
```

Read-only. Navigates, screenshots, dumps every visible control with a suggested Playwright selector,
and reports anti-bot wall signatures.

Both tools exist because a single one was not enough:

- `probe-carrier.js` inspects the DOM from inside the page, and **cannot see into closed shadow
  roots**.
- `probe-locators.js` uses Playwright's own locator engine, which resolves differently.

**Always look at the screenshot.** Two of the most expensive early mistakes were verdicts that
contradicted what the page plainly showed:

- Progressive's `/access/ez/login` returned HTTP 200 with no form. That was an ordinary **404 page**,
  not a block (F-07).
- GEICO reported `NO FORM FOUND` while rendering a complete login form. The probe sampled the DOM
  once and GEICO mounts late behind an Imperva challenge (F-06).

### The GEICO verdict, as a worked example of ruling a carrier out **wrongly**

This section used to hold a confident ruling-out. It was wrong, and it is kept — corrected — because
the mistake is more instructive than the conclusion was.

The original reasoning: after the probe was fixed to poll and to traverse *open* shadow roots, GEICO
still reported zero password fields, and `probe-locators.js` agreed:

```
dom-only  any visible input   count=8   editable=true
 no       password (type)     count=0
 no       submit button       count=0
  1 child frame(s): about:blank
```

From that, the note concluded the form sat in a **closed** shadow root that no selector could pierce,
and recorded it as "verified, not assumed".

**It was assumed.** What had been measured was an *absence*. "Closed shadow root" was one of at least
four causes that produce an identical observable — the others being a cross-origin iframe, a late
mount, and a wrong entry point — and no test had been run that could tell them apart.

The test that does: patch `Element.prototype.attachShadow` from an `addInitScript`, which runs before
any page script, and record every root as it is created. A closed root is only unreachable if you did
not hold the reference at creation time. Result:

```
shadow roots  0 total / 0 open / 0 closed
locator count input[type=password] = 1
pw first seen 5985ms
VERDICT       STRAIGHTFORWARD -- password field in the light DOM, locators see it
```

There is no shadow DOM on the page. GEICO is a **Flutter Web** app that mounts 2.3–6.2s after
`domcontentloaded` behind an Imperva challenge, and it is automatable with ordinary attribute
selectors. Full account in **F-32**; the working selectors are in the GEICO section below.

**The transferable lesson.** A negative verdict needs the same rigour as a positive one, and it
should have to name the experiment that would overturn it. The phrase "verified, not assumed" is the
tell — it asserted confidence in place of naming a test. Tools here now refuse to emit a *mechanism*
they did not test: `probe-geico-dom.js` reports `NO FIELD ANYWHERE -- wrong entry point, hard block,
or mount beyond the ceiling` rather than guessing at a cause.

---

## Step 2 · Record a real flow

This is the highest-yield step. One recording gave, for Progressive: the login and MFA selectors, the
complete auth state machine, the post-auth redirect chain, the document API endpoints, and the
"remember this device" checkbox.

```bash
npm run record <carrier>
# or: node tools/record-flow.js <carrier> --url https://carrier.example/login
```

A headed browser opens and **the user drives it** — typing their own password into the carrier's own
page, receiving their own SMS. The tool records only metadata.

### Never ask for a HAR file

A HAR captured from a real login contains the password in plaintext in the POST body, every session
cookie, and any PII the pages rendered. It is a credential dump.

The recorder captures the same structural information with redaction applied **at capture time**:
request bodies stored as field names and lengths only; sensitive keys dropped by pattern; cookie and
authorization headers reduced to names or schemes; JWTs and `*_token=` parameters scrubbed wherever
they appear, **including inside URLs** (see F-09 — that second channel leaked eight full tokens
before it was closed).

### Tell the user to do these things

1. Sign in normally in the browser window.
2. Complete MFA.
3. Navigate to the documents area **by clicking** — not by pasting a URL.
4. **Open the target PDF in the browser tab.** This is the step people skip and the one that matters
   most: it reveals the document URL and whether a cookie-authenticated GET is enough.
5. In the terminal, press Enter with a label at each stage (`login`, `mfa screen`, `documents`), then
   `q` to finish.

Run it **without** a proxy. The user's home IP is one the carrier already trusts, which isolates
adapter questions from proxy questions.

**Do one clean run.** Repeated automated-looking attempts are how accounts get locked.

---

## Step 3 · Mine the recording before writing code

```bash
python3 -c "
import json; d=json.load(open('artifacts/recordings/<carrier>/recording.json'))
for s in d['snapshots']: print(s['index'], s.get('label'), s['url'][:90])
"
```

Look for, in priority order:

1. **A machine-readable auth state.** Progressive's SPA polls
   `/pf-ws/authn/flows/{flowId}` and gets back an explicit status:
   `CREDENTIALS_REQUIRED → AUTHENTICATION_REQUIRED → OTP_REQUIRED → MFA_COMPLETED →
   DEVICE_PROPERTIES_REQUIRED`, with `devices:[{type:'SMS', target:'*******16'}]` on the challenge.
   If the carrier exposes anything like this, **drive the DOM but read state from the network.** It
   converts MFA detection from a selector race into a fact.
2. **A "remember this device" control.** Progressive's is
   `input[name="rememberThisDevice"]`. Ticking it plus a persistent profile means later pulls skip
   the SMS entirely — the largest single UX and latency win available.
3. **Generated DOM ids.** The recorder flags these as `idLooksGenerated`. Progressive regenerates
   its username and OTP field ids per load; only `#inputPassword` is stable. An adapter keyed on a
   generated id passes review and then fails permanently (F-08).
4. **The document API.** For Progressive: `GET /policypro/v1/account/documents` for the list, and
   `_links.target.href` per document.

If nested JSON was truncated as `<deep>`, use the full-depth capture:

```bash
npm run inspect:documents -- --download
```

It reuses the recorder's profile, so no new login is needed if the session is alive.

---

## Step 4 · Write the adapter

Extend `BaseCarrier` (`src/carriers/baseCarrier.js`), implement four methods, register in
`src/carriers/registry.js`. No frontend change is needed — the dropdown and MFA modal are driven
entirely by backend state.

```js
export class ExampleCarrier extends BaseCarrier {
  static id = 'example';
  static displayName = 'Example Insurance';
  static supportsSessionReuse = true;
  static usesProxy = true;
  static usePersistentProfile = true;   // required for device trust to persist
  static blockStylesheets = false;      // safer default; see below
  static extraAllow = ['api.example.com', 'idp.example.com'];

  async login(credentials) { /* → { mfaRequired, channel?, hint? } */ }
  async submitMfa(code)    { /* → { accepted } | { accepted:false, retryable:true } */ }
  async fetchDocuments()   { /* → [{ name, label, kind, mime, bytes }] */ }
  async isSessionValid()   { /* → boolean, for the warm path */ }
}
```

### Use `raceOutcomes()` after any submit

After a credential submit the next screen is genuinely non-deterministic: MFA challenge, straight to
dashboard, inline validation error, device-trust interstitial, or a bot wall. Waiting for the one you
hope for means every other branch costs a full timeout and then reports the wrong cause.

```js
const { outcome } = await this.raceOutcomes({
  mfa: 'input[autocomplete="one-time-code"]',
  badCredentials: 'text=/incorrect|does not match/i',
  authenticated: 'text=/Good (morning|afternoon|evening)/i',
}, { timeout: config.LOGIN_TIMEOUT_MS });
```

### Type per-character, not with `fill()`

`typeLikeHuman()` exists for a functional reason, not a stealth one: portals commonly bind validation
to `input`/`keyup`, so a value set in one shot leaves the submit button disabled and the run fails for
a reason that looks nothing like the cause. It costs ~1.5 s of the budget; the jitter range is the
tunable.

### Pitfalls that cost real time on Progressive

| Pitfall | Entry |
|---|---|
| `page.goto()` destroys an SPA's in-memory OAuth token → "session timed out" with zero API calls | F-17 |
| `context.request` shares cookies but **not** bearer tokens | F-10 |
| Copy all request headers minus a denylist; an allowlist cannot guess a vendor's private protocol | F-11 |
| PDFs may arrive base64 inside a JSON envelope — check before trusting magic bytes | F-13 |
| Never resolve a wait against cached state that predates the action | F-16 |
| A URL is not proof of authentication; require a 2xx on an authenticated request | F-18 |
| Leave stylesheets on until selectors are proven — visibility checks are computed from layout | — |

### Carrier reference · GEICO

Established by `tools/geico/probe-geico-{dom,flutter,typing}.js`. Full account in F-32 and F-33.

| | |
|---|---|
| Entry point | `https://ecams.geico.com/login` |
| Dead ends | `login.geico.com` does not resolve; `www.geico.com` has no password field |
| Framework | **Flutter Web**, HTML renderer (`flt-glass-pane`, 0 `canvas`, 40 `flt-semantics`) |
| Mount delay | **2.3–6.2s** after `domcontentloaded`, behind Imperva. Poll; do not sample once |
| Anti-bot | Imperva (`visid_incap_*`, `nlbi_*`, `incap_ses_*`) + Quantum Metric + OneTrust + Qualtrics |
| XSRF | `ASD-XSRF-TOKEN`, `XSRF-TOKEN`, `ApplicationSession` |
| Session reuse | **none** — 2SV is mandatory on every login (F-33) |

Working selectors, each verified by reading the typed value back:

```
username   input[autocomplete="email"]
password   input[type="password"]
backup     input[data-semantics-role="text-field"][type="text"|"password"]
submit     flt-semantics[role="button"] matched on the TEXT "Log In"
```

Three GEICO-specific traps:

1. **Never select the submit button by id.** It is `flt-semantic-node-N`, assigned in Flutter
   semantics-tree mount order. The same button was `node-37` on one load and `node-16` on the next.
2. **`#username` / `#current-password` look ideal and are not.** Flutter only materialises authored
   ids once focus enters the field, and `#username` stayed at count 0 even after clicking the
   password shell. Anything read from devtools *after you clicked the field* is a mirage.
3. **A delivery-method chooser sits between password and code entry** — GEICO asks email or SMS every
   time. Progressive has no equivalent step.

**State of the adapter.** `src/carriers/geico/` implements login and 2SV; `fetchDocuments()`
deliberately throws. Two things are unverified and one real login settles both:

| Unverified | Why it is not guessed |
|---|---|
| 2SV screen selectors | `MFA` in `selectors.js` is a candidate list written from GEICO's public FAQ, never seen in the DOM. Written as ordered lists so `firstVisible()` fails with `SELECTOR_DRIFT` rather than timing out on a guess. |
| The whole document flow | F-28. A guess that ranked by title text and recency returned a declarations page from a **lapsed** policy and reported success. Confidently wrong beats honestly broken only from the code's point of view, never the user's. |

```bash
npm run record:geico     # drive a real session; captures both, credential-safe
npm run audit:secrets    # verify the recording, do not trust the redaction (F-09)
```

When reading the recording, the question to answer first is the F-29 one: **does GEICO
expose its own taxonomy?** A category, document-type or policy-status field is the carrier
telling you which document is which. Title text and list position are not.

---

## Step 5 · Verify without burning logins

```bash
npm run repro:documents          # re-runs the real fetchDocuments() on a saved profile
npm run repro:documents -- --headed --no-blocking
```

A run that got past MFA leaves an authenticated persistent profile on disk. `repro-documents.js`
drives the **actual adapter method** against it, so document-phase bugs are diagnosable without a new
login and a new SMS. Both F-17 and F-18 were found this way.

It deliberately mirrors server runtime defaults (headless, blocking on), because
`inspect-documents.js` forces `HEADLESS=false` and `BLOCK_RESOURCES=false` — and that difference is
exactly the kind of thing that makes a bug reproduce in production but not in the harness.

If the document page behaves oddly:

```bash
node tools/trace-documents-page.js --headed   # every API call the page makes, per route
```

---

## Step 6 · Run the gate

```bash
npm run smoke:all
```

Six suites: OTP race regression, window arithmetic, API end-to-end, browser-level UI, metrics page,
secret audit. All must pass.

---

## Step 7 · Document it

Add entries to `docs/ENGINEERING-LOG.md` for anything that cost more than ~15 minutes to understand.
Use the template there. Record the actual error strings — a status code is a category, a response
body is an answer.

Update the carrier status table in `README.md`.

---

## Checklist

```
[ ] recon run; carrier not fronted by Akamai/Kasada on a short clock
[ ] probe-carrier + probe-locators agree a password field is reachable
[ ] screenshot reviewed (not a 404, not a challenge page)
[ ] flow recorded with real credentials, PDF opened in-tab
[ ] auth state source identified (network status > DOM polling)
[ ] "remember this device" control found, if any
[ ] generated DOM ids identified and avoided
[ ] document list + download endpoints known, envelope shape checked
[ ] adapter implements login / submitMfa / fetchDocuments / isSessionValid
[ ] registered in registry.js
[ ] verified via repro:documents without a fresh login
[ ] npm run smoke:all passes
[ ] engineering log updated
[ ] README carrier table updated
```
