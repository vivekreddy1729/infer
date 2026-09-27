# Debugging Toolkit

Every diagnostic in this repo, what question it answers, and when to reach for it. Ordered by how
early you would use it.

Most of these exist because a specific debugging session went badly without them. Where that is the
case, the relevant `docs/ENGINEERING-LOG.md` entry is cited.

---

## Decision table

| Symptom | Start here |
|---|---|
| A run failed and I was not watching | `logs/failures/` — a bundle was written automatically |
| Need logs from a deployed instance | `GET /api/diagnostics/logs.txt` (token-gated) |
| Login works, documents fail | `npm run repro:documents` — no new login needed |
| Not sure if the saved session is alive | `npm run repro:documents` reports it first |
| Document page behaves oddly | `node tools/trace-documents-page.js --headed` |
| Considering a new carrier | `npm run recon` then `node tools/probe-carrier.js <url>` |
| Selectors do not match | `node tools/probe-locators.js <url>` (pierces shadow DOM differently) |
| Need the full API payload shape | `npm run inspect:documents -- --download` |
| Is anything leaking secrets? | `npm run audit:secrets` |
| Is the page actually usable? | `npm run smoke:ui` |
| Are the latency numbers right? | `npm run test:windows` |
| Did I reintroduce the OTP race? | `npm run test:race` |

---

## Observability

### Failure bundles — `logs/failures/`

**The first thing to look at.** Every failed run writes a self-contained JSON document automatically,
no flags required:

```
logs/failures/2026-09-26T14-56-29-299Z_progressive_NO_DOCUMENTS.json
```

Filenames are sortable and self-describing, so a directory listing is already a summary. Each bundle
holds the state-machine timeline with elapsed offsets, per-phase timings, carrier internals
(`debugState`: PingFederate flow history, harvested header count, whether an authenticated API call
succeeded, current URL), an environment snapshot, and every log line for that session.

Written unprompted because sessions are reaped within a minute of settling — by the time a user says
"it failed", in-memory state is gone (F-21).

Redacted and safe to share; `npm run audit:secrets` verifies that.

```bash
python3 -c "
import json; d=json.load(open('logs/failures/<file>.json'))
for t in d['session']['timeline']:
    print(f\"+{t['elapsedMs']:>6}ms {t['state']:<16} {t['message'][:70]}\")
print(json.dumps(d.get('carrierDebug'), indent=2))
for e in d['logs']['lines']: print(e.get('level'), e.get('msg'))
"
```

### Logs — `logs/app.log`

NDJSON, rotating at 20 MB × 10 files, written **by the application** rather than by shell
redirection. That distinction is the whole point: piping to `tee` works until the process is started
a different way, and then the logs for the run you care about simply do not exist (F-21).

```bash
npm run logs:tail            # follow
npm run logs:errors          # last 50 error-level lines across rotations
python3 -c "
import json
for l in open('logs/app.log'):
    e=json.loads(l)
    if e.get('sessionId','').startswith('9be3b5fb'): print(e.get('level'), e.get('msg'))
"
```

### Diagnostics endpoints

For a deployed instance with no shell access:

```bash
T=$DIAGNOSTICS_TOKEN
curl -H "Authorization: Bearer $T" https://app/api/diagnostics
curl -H "Authorization: Bearer $T" "https://app/api/diagnostics/logs.txt?limit=5000" -o app.log
curl -H "Authorization: Bearer $T" "https://app/api/diagnostics/logs?sessionId=<id>&level=warn"
curl -H "Authorization: Bearer $T" https://app/api/diagnostics/sessions/<id> -o bundle.json
```

`DIAGNOSTICS_TOKEN` set ⇒ bearer required. **Unset ⇒ loopback only**, so a deployment that forgets
the token is locked down rather than exposed. Comparison is constant-time.

### Metrics — `/metrics.html`

Per-phase min/median/avg/max/p95 across all runs, multi-select filters, and four measurement windows
(wall / excluding MFA wait / excluding transfer / excluding both). See `README.md` for why four.

`/api/metrics?carrierId=progressive,demo&path=cold,warm&outcome=COMPLETED,ERROR&window=exclBoth`

Tick the `ERROR` outcome to see how far failing runs got — that is often more informative than the
timings of healthy ones (F-26).

---

## Carrier reconnaissance

### `npm run recon` / `npm run recon:deep`

Read-only curl over carrier login pages, fingerprinting the anti-bot vendor from headers, cookie
names and script hosts. Cheapest possible filter. No credentials, no POSTs.

### `node tools/probe-carrier.js [urls...]`

Drives the **real stack** (Patchright, stealth config, resource blocker) at a login page and reports
whether we are served the form or a wall. Dumps every visible control with a suggested Playwright
selector, flags machine-generated ids, screenshots to `artifacts/probes/`.

Polls for a password field rather than sampling once, and traverses open shadow roots — both because
the first version reported `NO FORM FOUND` for a page that rendered perfectly (F-06).

**Always open the screenshot.** It has twice contradicted the verdict.

### `node tools/probe-locators.js <url>`

Asks the only question that matters before committing to a carrier: *can Playwright's locator engine
see and type into the login fields?* Resolves differently from `page.evaluate`, and the gap between
the two routes is real signal.

Also enumerates child frames and flags which one holds a password field.

**A caution this tool earned.** Agreement between `probe-locators.js` and `probe-carrier.js` was
treated as confirmation that GEICO's form sat in a closed shadow root. Both were right that no
password field was *reachable*, and both were wrong about why — the page had simply not mounted yet,
and no shadow DOM existed at all (F-32). Two tools that resolve selectors at the same moment share
the same blind spot, so their agreement is one observation, not two. Neither can distinguish
*absent* from *not yet present*.

### GEICO-specific probes

`tools/geico/` holds three probes built to settle that question properly. They are deliberately
self-contained and share no code with the Progressive tooling.

| Tool | Question it answers |
|---|---|
| `probe-geico-dom.js` | Is a field genuinely unreachable, and *why*? Patches `attachShadow` before page scripts so closed roots are captured, enumerates via four independent routes, and walks the keyboard focus trail. |
| `probe-geico-flutter.js` | Does Flutter's semantics tree need activating, and do authored ids materialise? |
| `probe-geico-typing.js` | Can we actually type into the fields? Races three selector strategies and **verifies by reading the value back** rather than trusting `type()` to resolve. |
| `dump-geico-page.js <url>` | What does an arbitrary GEICO page contain? Renders it (plain fetch returns an empty shell) and captures JSON API responses. |
| `record-geico-flow.js` | **The one that unblocks the document work.** Records a real session while a human drives it: the 2SV screens, the documents page structure, the filter controls, and the document endpoint. |

`npm run record:geico` is the next step for GEICO. Two things in the adapter are
unverified and one login settles both: the 2SV selectors (candidate lists written from
GEICO's FAQ, never seen in the DOM) and the entire document flow, which
`fetchDocuments()` currently refuses to guess at.

What it will and will not write down matters:

- **Never a HAR file.** A HAR from a real login holds the password in plaintext in the
  POST body plus every cookie and bearer token. Asking for one is asking someone to
  email their credentials.
- Records header **names** only, never values — which is what made Progressive's
  `x-prgaccountsessionid` findable (F-11) without turning the artefact into a
  credential store.
- Redaction is deliberately aggressive and independently unit-tested, because F-09 was
  a leak *in the redaction code itself*. Run `npm run audit:secrets` on the output
  anyway rather than trusting it.
- Holds the browser open until you press Enter, and appends every capture as it
  happens. F-14 was a tool that closed the browser it was inspecting.

The rule these encode: a probe may report a *measurement* ("no password field found") but must not
report a *mechanism* it did not test ("closed shadow root"). `probe-geico-dom.js` says `cause
undetermined` where the older tools guessed.

---

## Flow capture

### `npm run record <carrier>`

Interactive headed recorder. The user signs in; the tool records request/response metadata, JSON
payload shapes, per-step DOM snapshots with suggested selectors, and which response delivered the PDF.

**This replaces asking for a HAR file**, which would be a credential dump. Redaction is applied at
capture time — request bodies become field names and lengths, credential headers become schemes, and
JWTs and `*_token=` parameters are scrubbed wherever they appear *including inside URLs* (F-09).

```bash
npm run record progressive
npm run record progressive -- --save-pdfs      # keeps bytes; real PII, artifacts/ is gitignored
```

Terminal controls: `<label><Enter>` forces a labelled snapshot, `q<Enter>` finishes.

### `tools/scrub-recording.js <file>`

Retroactively removes credential material from a recording written before F-09 was fixed. Takes a
`.bak` first, validates the result still parses as JSON, and refuses to write if not.

### `npm run inspect:documents -- --download`

Full-depth capture of the documents API. Exists because the recorder's redaction summariser truncates
nested objects at depth 4 — correct for avoiding PII spills, but it discarded the `_links` objects
holding the download URLs.

Prints URLs as path templates (`{policyNumber}`, `{uuid}`) so structure is legible without exposing
identifiers. Tries each download strategy **twice** — once with harvested bearer headers, once
cookies-only — so the output proves the auth mechanism rather than asserting it.

Reuses the recorder's profile, so no new SMS if the session is alive. Holds the browser open until
`q` (F-14).

---

## Reproduction without new logins

### `npm run repro:documents`

**The most useful tool here.** A run that got past MFA leaves an authenticated persistent Chrome
profile on disk. This drives the **real** `ProgressiveCarrier.fetchDocuments()` against it.

Both F-17 (hard navigation destroying the OAuth token) and F-18 (`isSessionValid` false positives)
were found with it, with zero additional logins.

```bash
npm run repro:documents                      # server defaults: headless, blocking on
npm run repro:documents -- --headed          # watch it
npm run repro:documents -- --no-blocking     # rule the resource blocker in or out
npm run repro:documents -- --list            # show profiles and exit
```

It checks the session is valid before blaming the document code, and prints `debugState`, blocking
stats, phase timings, the final URL, and a full API trace including calls that carried **no**
authorization — which is how "the app made no API calls at all" became visible.

### `node tools/trace-documents-page.js [--headed]`

Navigates to several candidate app routes and lists every API call each makes, plus what rendered.
Built to settle one question: *did we navigate wrong, or does the app need a nudge before it loads
data?* The answer was neither — see F-17.

---

## Test suites

`npm run smoke:all` runs all six. Individually:

| Command | Proves |
|---|---|
| `npm run test:race` | The OTP stale-read race cannot regress. No browser, ~1 s. Includes the *buggy* waiter to prove the test detects the original defect. |
| `npm run test:windows` | Measurement-window arithmetic. Asserts no window subtracts a composite phase, which would under-report latency. |
| `npm run smoke` | Full flow over the real transport, PDF magic bytes validated, warm path asserted on a second run. |
| `npm run smoke:ui` | The page is **usable**, not merely served. Checks computed `display` and click actionability. |
| `npm run smoke:metrics` | Metrics render real numbers, chart geometry sane, statistical invariants hold. |
| `npm run audit:secrets` | Nothing the app writes contains credential material. |

### Why `smoke:ui` exists

Every backend test passed while the application was completely unusable in a browser — an
`[hidden]`-versus-CSS-specificity bug left an invisible overlay swallowing every click (F-15). It
checks **computed style**, not the attribute (the attribute was correct all along), and uses
Playwright's `{ trial: true }` click actionability rather than `isVisible()`, because a covering
overlay leaves fields visible but unclickable.

### Negative controls

Two suites verify they can actually fail, because a check that always passes is indistinguishable
from no check:

- `test-flow-race.js` runs the original buggy waiter and asserts it returns the stale value in 0 ms.
- `audit-secrets.js` was validated by planting a real secret and confirming it failed.

---

## Housekeeping

```bash
npm run metrics:reset      # delete data/metrics.jsonl
npm run profiles:clear     # delete Chrome profiles; next run falls back to cold login
rm -rf data/sessions       # drop encrypted storageState; forces the cold path
```

**`data/profiles/` is credential-bearing.** It holds live session cookies *and* the carrier's OAuth
access token, because the token arrives in a URL fragment and Chrome records visited URLs in
`History` and its session-restore files. Nothing we write puts it there; Chrome does. Never attach a
profile directory to a bug report. `npm run audit:secrets --include-profiles` will show you.
