# Engineering process for this repository

Read this before changing code. It is short, and it exists because several expensive mistakes in this
project were made twice.

## The two logs are not optional

| Document | Records | Add an entry when |
|---|---|---|
| `docs/ENGINEERING-LOG.md` | what broke, root cause, fix, guard | anything took more than ~15 minutes to understand |
| `docs/OPTIMISATION-LOG.md` | **why** an approach was chosen, in what order, and why it failed | you change anything for performance reasons |

Both are **append-only**. Number entries sequentially (`F-NN`, `O-NN`) and never reuse a number. If a
later change supersedes an earlier one, add a new entry and cross-reference — a corrected wrong turn
is one of the more useful things in there.

Each file has a template at the top. Use it.

### What makes an entry worth writing

Not every change. The ones where **the cause was surprising**, or where a plausible approach turned
out to be wrong. Ask: *would I have to re-derive this?* If yes, write it down.

### What makes an entry useful

Record the evidence, not the conclusion.

- ❌ "It was a header problem."
- ✅ `400 "AccountSession header missing"` — the header was `x-prgaccountsessionid`.

Record what you **ruled out**. Most of the cost is in the wrong hypotheses, and the next person will
otherwise form the same ones.

Record the number. Every performance claim in `OPTIMISATION-LOG.md` is a measured figure. One
estimate that got in without measurement was wrong by 3× and mis-sized the next decision.

**Never paste credentials, tokens or cookies** — not even expired ones. See F-09, where the redaction
code itself was the leak.

## Optimisation procedure

Follow the order. It is in `docs/OPTIMISATION-LOG.md#method` in full; the short version:

1. **Measure first.** "This step feels slow" has been wrong here more than once. Decompose the wall
   clock and check the phases sum.
2. **Check attribution.** Ours / the user's / the carrier's. They need different treatment, and
   conflating them produces a number that is either flattering or meaningless.
3. **Cheapest reversible change first.** Order by cost-to-try and cost-to-undo, not by expected gain.
4. **Suspect your instrumentation.** If phases do not sum to the wall clock, the gap *is* the finding.
   Twice here the unattributed remainder exceeded everything measured.
5. **Verify the postcondition, not the call.** See below.
6. **Re-measure and keep the number.**
7. **Write the entry.**

Check `docs/OPTIMISATION-LOG.md#rejected-approaches-and-why` before proposing something — ten
approaches have already been tried and rejected with reasons.

## Four failure patterns that have recurred here

Check for these specifically. Each has caused more than one bug.

**1. Blanket transformations damage what they do not understand.**
`chmod -R` over a browser tree (F-05), `.overlay { display: flex }` overriding `[hidden]` (F-15),
`Object.entries` rebuilding every log object and stripping prototype getters (F-22). Before reaching
for a recursive or global operation, enumerate what it will touch.

**2. A tool that lies is worse than no tool.**
A probe reporting "NO FORM FOUND" for a page that rendered perfectly (F-06). An inspection tool
closing the browser it was inspecting (F-14). `isSessionValid()` returning true for a dead session
(F-18). A secret audit failing on its own redaction markers (F-25). Every diagnostic here now has a
negative control or an explicit "what would prove this wrong" check.

**3. A swallowed failure plus a success message is a silent permanent regression.**
`check({ timeout: 3000 }).catch(() => {})` followed by "device will be remembered" — which had never
worked for the project's entire history (O-5). Verify the postcondition (`isChecked()`) or do not
claim the outcome.

**4. Never resolve a wait or a decision against state that predates the event.**
F-16 read a cached auth status from before the code was submitted and declared a correct code wrong.
O-6 then made the mirror-image mistake — reading a status *before* the state could have advanced —
and broke authentication outright. Note that documenting F-16's lesson did **not** prevent O-6. A
written lesson only protects against the exact shape you wrote down; add a regression test.

## Verification

`npm run smoke:all` must pass before you call something done. Seven suites: OTP race, measurement
windows, document selection, API end-to-end, browser-level UI, metrics page, secret audit.

Two things that are easy to get wrong:

- **"The endpoints work" ≠ "a person can use it."** Every backend test passed while the app was
  completely unusable in a browser (F-15). `npm run smoke:ui` exists for that and checks *computed*
  style plus click actionability, not `isVisible()`.
- **A test that cannot fail is not a test.** `test-flow-race.js` runs the original buggy waiter to
  prove it detects the defect; `audit-secrets.js` was validated by planting a real secret. Do the
  same for new guards.

## Carrier work

Before touching an adapter, read the entries tagged for that carrier — several fixes look arbitrary
until you know what they defend against, and anything marked `LOAD-BEARING` is guarding a failure
that is silent when reintroduced.

For a new carrier, follow `docs/CARRIER-ONBOARDING.md`. It is sequenced so the cheapest checks
eliminate the most candidates and no real login is spent on an unanswered question.

Two specifics that cost real time:

- **Use the carrier's own taxonomy** (document categories, types, term records) rather than matching
  title text or list position. Titles are localisable copy; `categories.includes('Contract')` is the
  carrier telling you the answer (F-29).
- **Never key a selector on a generated DOM id.** Progressive regenerates its username and OTP field
  ids per page load. An adapter built from devtools ids passes review and then fails permanently, in
  a way that looks like anti-bot (F-08).

## Restarting the server

Config is read **once at boot**. A `.env` edited afterwards looks correct on disk while the process
runs on the old value, and nothing in the UI will say so. After any change, confirm the running
process actually has it — `/api/health` reports the loaded config for this reason. Verify behaviour,
not file timestamps: a restart in this project has silently failed to take at least once.
