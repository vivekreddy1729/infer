# Optimisation Log

Why each performance decision was made, in the order it was made, including the ones that failed
and what the failure changed.

## How this differs from the engineering log

| Document | Question it answers |
|---|---|
| `ENGINEERING-LOG.md` | *What broke, and how was it fixed?* |
| **`OPTIMISATION-LOG.md`** | *Why was this approach chosen first, what did it cost, and why did we move on?* |

The engineering log is a record of defects. This is a record of **reasoning**. Several entries here
describe approaches that were correct-looking, cheap to try, and wrong — and the sequence matters,
because the failure is usually what revealed the right approach.

If you only read one thing before optimising something here, read
[Method](#method) and [Rejected approaches](#rejected-approaches-and-why). The second will save you
from re-running experiments that have already been run.

---

## Method

The process that produced everything below. **Follow it.**

### 1. Measure before touching anything

"It's slow" is not actionable and "this step feels slow" is usually wrong. The first Progressive
analysis found that two of the three biggest costs were in phases nobody had named, and that the
step the user pointed at was not the step consuming the time.

Run it, read `data/metrics.jsonl`, and decompose the wall clock into phases that sum correctly.

### 2. Check whether the time is even attributable to us

Three categories, and they need different treatment:

| Category | Example | What to do |
|---|---|---|
| **Ours** | a blind selector poll | fix it |
| **The user's** | reading an SMS | exclude it from the budget, report it separately |
| **The carrier's** | processing credentials, issuing an SMS | measure it, state it, stop |

Conflating these produces either a flattering number or a meaningless one. See
[O-2](#o-2--two-clocks-instead-of-one-number) and [O-3](#o-3--four-measurement-windows).

### 3. Prefer the cheapest reversible change first

Order candidates by *cost to try* and *cost to undo*, not by expected gain. A one-line constant
change that can be reverted in seconds should be tried before a new subsystem, even if the subsystem
promises more — because you learn the shape of the problem cheaply, and sometimes the cheap change
is enough.

### 4. Suspect your own instrumentation

If the measured phases do not sum to the wall clock, the gap **is** the finding. Twice here, the
unattributed remainder was larger than everything that was being measured
([O-1](#o-1--measure-first-and-find-the-instrumentation-gaps),
[O-12](#o-12--instrument-the-gap-before-optimising-it)).

### 5. Verify the postcondition, not the call

An optimisation that appears to work because its failure is swallowed is worse than no
optimisation — it is a permanent silent regression. [O-5](#o-5--tighten-the-blind-polls) found one
that had never worked in the project's entire history.

### 6. Re-measure, and keep the number

Every claim in this file is a measured number from `data/metrics.jsonl` or a reproduced experiment.
If you cannot produce a number, say so rather than estimating — one estimate in here was wrong by
3× and sent the next decision in the wrong direction.

### 7. Record the reasoning, not just the outcome

Add an entry below. The order and the failures are the valuable part; the final state of the code is
already in the code.

### Entry template

```markdown
### O-NN · <title>

**Problem.** What was observed, with numbers.

**Options considered.** Including the ones not taken.

**Why this one first.** Cost to try, cost to undo, evidence available. This is the important part.

**Result.** Measured. Before → after.

**Why it failed / what it cost.** If applicable.

**What we did instead, and why.** If applicable.

**Status.** working / superseded by O-NN / abandoned
```

---

## The problem being solved

The brief asks for **under 8 seconds from login to document on screen**. The starting point on a
real Progressive account:

```
machine time 23,760ms   wall 47,531ms   (human MFA wait 23,771ms)
```

Three top-level blocks, and the sum of their children did not account for them:

| Block | Time | Accounted for by named child phases |
|---|---|---|
| `acquire_context` | 824ms | — |
| `login` | 9,613ms | 3,205ms → **6.4s unattributed** |
| `mfa_submit` | 8,285ms | ~400ms of typing → **7.9s unattributed** |
| `documents` | 4,851ms | 4,780ms |
| `persist_session` | 107ms | — |

Current state: **12,736ms machine time**, with the remaining bulk being carrier-side.

---

## Decision records

### O-1 · Measure first, and find the instrumentation gaps

**Problem.** The user reported two status lines as slow. No data on whether they were.

**Options considered.**
1. Act on the report directly — tighten the two steps named.
2. Add timing instrumentation and decompose the whole run first.
3. Profile the Node process.

**Why this one first.** (2), because it is nearly free — per-phase timing already existed for the
latency claim — and because acting on (1) without data risks optimising something that is not the
cost. (3) was wrong for the shape of the problem: almost all the time is spent waiting on a browser
or a carrier, not burning CPU, so a profiler would show an idle event loop.

**Result.** Immediately productive, and not in the expected way. The two blocks with the most time
had **more time unattributed than attributed** — 6.4s inside `login` and 7.9s inside `mfa_submit`.
The instrumentation gap was the first finding, before any optimisation.

**Status.** working — and the reason every entry below has numbers.

---

### O-2 · Two clocks instead of one number

**Problem.** "Under 8 seconds" is unmeasurable as written, because the flow contains a mandatory
human step. Nobody controls how long someone takes to read an SMS and type six digits. Observed
human waits: 11.9s, 12.7s, 16.0s, 23.8s.

**Options considered.**
1. Report wall clock. Honest, but the number says more about the user's typing than the system, and
   it can never meet an 8s budget.
2. Report wall clock minus the human wait, as a single figure. Meets the budget, but silently
   excludes something the reader would want to know about.
3. Report both, and define which one the budget applies to.

**Why this one.** (3). (1) makes the figure useless for engineering decisions; (2) is the kind of
number that looks fine until someone asks what it excludes, and then the whole measurement loses
credibility. Reporting both costs nothing and makes the claim auditable — which matters more than
making it look good.

**Result.** `machineMs` (budget applies) and `wallMs` (full truth), both surfaced in the UI and
metrics. Later generalised by O-3.

**Status.** working, extended by O-3.

---

### O-3 · Four measurement windows

**Problem.** The user observed that document download time depends on their internet speed, so it
is not a fair measure of the code either.

**Options considered.**
1. Add a second exclusion to `machineMs`, making it "wall minus human minus transfer".
2. Add a toggle that switches the headline between definitions.
3. Compute every combination and show them side by side, with one selected as the headline.

**Why this one.** (3). The insight from O-2 generalises: rather than argue about which definition is
correct, compute all of them over the same run set so the *differences* become the information. The
gap between wall and excluding-MFA is how much of the experience is the person; the gap to
excluding-transfer is how much is the network. (1) would have repeated O-2's mistake at a larger
scale — a single number with two hidden exclusions is worse than one with one.

**Result.** Four windows. Measured on demo cold runs: wall 3,819ms → −402ms (MFA) → −63ms
(transfer) → 3,353ms.

**A trap worth knowing.** Naive subtraction would have been wrong. Phase records contain
**composite** entries — `login` wraps `nav_login` + `await_login_form` + `fill_credentials` +
`submit_credentials`; `documents` wraps the list and download steps. Summing every phase exceeds the
wall clock: **48,594ms of phases against 40,158ms of wall clock** on a real run. Subtracting a
composite would have removed time twice and reported latency *lower than reality* — the worst
possible direction for a number whose job is to substantiate a performance claim. Windows subtract
only non-overlapping leaves, and `npm run test:windows` asserts it.

**Status.** working.

---

### O-4 · Reduce the per-character typing delay

**Problem.** `fill_credentials` at ~1,600ms was the largest controllable slice of the machine path.

**Options considered.**
1. Use `fill()` to set the value in one operation.
2. Type username and password concurrently.
3. Reduce the per-character delay.
4. Leave it — the delay is anti-bot protection.

**Why this one first.** (3), because it is a constant: seconds to change, seconds to revert, and the
measurement tells you immediately whether it mattered. That reversibility is the entire argument for
trying it before anything structural.

(1) is ruled out by the reason `typeLikeHuman` exists at all — portals bind validation to
`input`/`keyup`, and a one-shot `fill()` leaves the submit button disabled. That is a functional
requirement, not a stealth one. (2) is impossible: both fields are on one page driven by one
keyboard, so the operations are inherently sequential.

(4) deserved scrutiny rather than deference. On inspection the justification was weaker than its
comment implied: the functional requirement is satisfied by *any* non-zero delay, and the
behavioural argument only defeats the crudest check — "entire field populated within one event-loop
tick". Nothing in the recon suggested these carriers model keystroke cadence. 24–92ms (~58ms
average) was cargo-culted caution, not a measured requirement.

**Result.** 10–35ms (~22ms average). `fill_credentials` **1,600ms → 719ms**. Still well above the
one-tick threshold. Made configurable (`TYPE_MIN_DELAY_MS` / `TYPE_MAX_DELAY_MS`) so it can be
raised for a carrier that proves sensitive.

**Status.** working.

---

### O-5 · Tighten the blind polls

**Problem.** `mfa_submit` was 8,285ms containing roughly 400ms of actual work.

**Hypothesis, and why.** Selector helpers return as soon as the element appears, so a generous
timeout costs nothing *when the element is present*. An 8s phase doing 400ms of work therefore
implies elements that are **absent** — so the question is not "why is this slow" but "what are we
waiting for that is not there". That reframing is what made it findable.

**Result — and it became a correctness fix.** Two blind polls, and the first was not merely slow:

`check({ timeout: 3000 }).catch(() => {})` on the "Remember this device" checkbox, followed
unconditionally by a message telling the user the device would be remembered. Progressive renders
that control the way most design systems do — the real input under a styled proxy that intercepts
pointer events. Playwright's actionability wait never satisfies. Reproduced in isolation:

| Approach | elapsed | result |
|---|---|---|
| `check({ timeout: 3000 })` | **3,003ms** | `isChecked: false` |
| `check({ force: true })` then verify | **19ms** | `isChecked: true` |

So the single largest optimisation in the adapter — skipping the SMS on repeat runs — had **never
functioned**, and the `.catch(() => {})` meant nothing ever said so. Every run took the cold path
with a fresh challenge, which had been attributed to session expiry.

**Fix reasoning.** `force: true` to bypass a wait that cannot be satisfied, then `isChecked()` to
establish what actually happened, then a label click as fallback, then an honest `log.warn` if it
still fails. The rule generalises: **an action wrapped in a swallowed catch, followed by a claim
that the action succeeded, is a lie waiting to happen.** Verify the postcondition or do not claim
it.

**Status.** working. 3,029ms recovered, plus a latent correctness bug closed.

---

### O-6 · Gate the device-prompt handler on flow status — **FAILED**

**Problem.** The second blind poll: `#clearDevicePropertiesPrompt()` ran after every accepted code
with a 3,500ms selector timeout, so runs without that interstitial waited 3.5s for an element that
would never appear.

**Options considered.**
1. Shorten the timeout. Cheap, but keeps paying a cost for a screen we could know about.
2. Gate on the PingFederate flow status, which already reports `DEVICE_PROPERTIES_REQUIRED`.
3. Race the interstitial against evidence of authentication.

**Why (2) first.** It looked strictly better than everything else and used information already in
hand. The adapter's whole design philosophy is *drive the DOM, read state from the network* — the
flow status had already converted MFA detection from a selector race into a fact. Using it here was
the same move. Turning a 3.5s gamble into a decision, for free.

**Why it failed.** **PingFederate emits `MFA_COMPLETED` before `DEVICE_PROPERTIES_REQUIRED`.** The
status was read at the instant the code was accepted, when it was necessarily still the former. So
the check concluded no interstitial was coming and skipped the click that advances
`setDeviceProperties`. The flow never completed:

```
flowHistory: CREDENTIALS_REQUIRED → AUTHENTICATION_REQUIRED → OTP_REQUIRED
             → MFA_COMPLETED → CREDENTIALS_REQUIRED      ← flow restarted
apiAuthOk: false   url: …/access/login?fd=accountHome
```

Progressive tore the session down ~1s later, and the run failed two phases later with
`NO_DOCUMENTS` and "Progressive signed this session out" — pointing nowhere near the cause. An
optimisation had become an authentication failure with a misleading error.

**What we did instead, and why.** (3). Neither a snapshot nor a blind poll: after acceptance, wait
for whichever arrives first — `DEVICE_PROPERTIES_REQUIRED` (handle it), a successful authenticated
API call, or an app route — capped at 8s. Fast in the common case because it exits on the first
signal, correct in the case that matters because it does not decide before the evidence exists.

**The meta-lesson, which is the real value of this entry.** This is F-16's lesson violated in mirror
image. F-16 was resolving a *wait* against state that predated the action; this was resolving a
*decision* against state that predated the event. Having written "never resolve a wait against state
that predates the action" in the engineering log did not prevent making the inverse mistake days
later. **A documented lesson only protects against the exact shape you wrote down.** Hence the
regression test (`npm run test:race` scenario 6) rather than a note.

**Status.** superseded by the race approach; the failure is retained here deliberately.

---

### O-7 · Move session persistence off the critical path

**Problem.** `persist_session` (~107ms of disk and AES work) sat between retrieving the PDFs and
showing them.

**Options considered.**
1. Leave it. It is only 107ms.
2. Background it, awaited at teardown.
3. Drop it on the success path and persist lazily elsewhere.

**Why this one.** (2). The reasoning is not the 107ms but *who it is for*: session persistence is
bookkeeping to make **future** runs fast and has no bearing on the documents already in hand.
Anything that benefits nobody currently waiting should not be on the path they are waiting on. (3)
risked losing the warm path entirely for a marginal gain.

**Complication, and why it mattered.** The browser context must stay open for
`exportStorageState()`, and `#cleanup()` closes it — so the promise is captured and awaited at
teardown with a 3s cap. "Don't block the user" must not become "lose the session on a fast
shutdown", and a hung save must not hold a Chrome process open.

**A self-inflicted problem this created.** Backgrounding it meant the timing summary was taken
before it finished, so `persist_session` vanished from the metrics — breaking the claim in its own
comment that it stayed measured. Fixed by recording metrics *after* cleanup, while the user-facing
payload still goes out early. The user-facing path and the measurement path have different deadlines
and that is fine, but it has to be deliberate.

**Status.** working.

---

### O-8 · Memoise a call known to fail

**Problem.** The direct documents-list API call returns 400 on this account every run (F-19,
route-scoped headers), costing ~405ms before falling back to the page path.

**Options considered.**
1. Identify the route-scoped header and fix the root cause.
2. Remove the direct call and always use the page fallback.
3. Memoise the failure per process and skip the call after the first.

**Why (3) first.** Honest cost-benefit. (1) is the correct fix but needs a header diff between two
routes and an unknown amount of investigation — and the logging to support it only landed with F-20.
(2) throws away the fast path for accounts where it *does* work, on the evidence of one account.
(3) is five lines, self-correcting on restart, and costs one wasted call per process rather than one
per run.

**Result.** ~405ms per run after the first. Root cause remains open and is flagged as such — a
workaround recorded as a workaround, not quietly reframed as a solution.

**Status.** working; root cause open (F-19).

---

### O-9 · Pre-warm by sending the username early — **REJECTED**

**Problem.** `acquire_context` + `nav_login` + form render all happen after submit but depend on
nothing the user typed.

**Proposal.** Have the frontend send the username when the user finishes typing it, so a per-user
persistent Chrome profile could be pre-warmed and parked on the login page.

**Why it was proposed.** Progressive used `usePersistentProfile = true`, and the profile key is
derived from the username. Pre-warming therefore *appeared* to require the username, and sending it
early looked like the only way to unblock a large win.

**Why it was rejected.** The user declined to send credentials ahead of submission. Correct on
privacy grounds, and it forced a better design.

**What we did instead, and why it is better.** See O-10. The blocker turned out to apply only to the
half of the problem that did not need solving.

**Status.** abandoned — productively.

---

### O-10 · Anonymous pre-warmed page pool

**Problem.** Same as O-9.

**The reframing that unlocked it.** Separating the two paths:

| Path | Needs username? | Cost | Pre-warmable? |
|---|---|---|---|
| Warm (saved `storageState`) | yes, to locate the state | ~0.4s | no — **and it does not matter** |
| **Cold (fresh login)** | **no** | ~12.7s | **yes** |

The path that cannot be pre-warmed is already fast; the path that is slow needs nothing
user-specific. So a parked page is **anonymous by design** and no credential arrives early.

**Why this approach over the alternatives.**

- *Pre-warm on a timer* — rejected. Continuously reloading carrier login pages from one residential
  IP with zero logins is a distinctive traffic pattern, and directly contradicts the rest of the
  anti-bot work. Replenishment is lazy and demand-driven so page loads stay proportional to real
  pulls.
- *Pool many pages per carrier* — rejected for now. One is enough for the observed concurrency, and
  each parked page holds a browser context.
- *Keep pages indefinitely* — rejected. Progressive mints a PingFederate `flowId` per login-page
  load; a stale page submits against an expired flow and fails **after** the user has typed, which
  is strictly worse than no pre-warming. Hence a TTL plus re-validation immediately before handover.

**Result.** Prepare cost for Progressive measured at **2,703ms / 6,437ms / 19,063ms** across runs.
Adoption: **4–6ms**. The variance is the strongest argument for the feature — the user never pays
it, whatever it happens to be that minute.

**A consequential decision.** Progressive moved off persistent profiles, because
`launchPersistentContext` needs a username-derived key and is therefore fundamentally
un-pre-warmable. Justified by three things rather than one: device trust never actually worked
anyway (O-5), `storageState` carries the same cookies while being encrypted *and* portable across
redeploys (profiles are machine-local and destroyed by every Fly deploy), and it removes a ~824ms
browser launch per session. The cost — Patchright documents persistent contexts as its most
undetectable mode — is real, accepted, and reversible per carrier.

**Two sub-failures found while testing.**

*Borrowed the wrong timeout.* Prepare used `NAV_TIMEOUT_MS` (20s), which is sized for a navigation a
user is waiting on. Observed `page.goto: Timeout 20000ms exceeded` against Progressive, leaving
nothing parked and silently forfeiting the optimisation. Background work should not inherit
foreground deadlines: now a separate 45s ceiling plus two bounded retries.

*Lazy replenishment alone had a timing hole.* A page parked at boot had usually expired before
anyone arrived (`expiresIn=0s` observed), so the first real pull got no benefit. Timer-refreshing
would have reintroduced the beacon problem. Resolved with `POST /api/prewarm`, which the UI calls on
carrier selection — **demand-driven, not clock-driven**: the page is parked while the user types,
landing 15–30s ahead of submission and well inside both the TTL and the carrier's token lifetime.

**Status.** working.

---

### O-11 · Fix the number, not just the code

**Problem.** The user reported *"Asked Progressive to remember this device… 37.3s"* as a slow step.
It was not a step duration — the status log showed **cumulative elapsed**, so `37.3s` meant "this
happened 37.3 seconds into the run".

**Why this belongs in an optimisation log.** The misreading was not the user's error, it was the
UI's. A number that can be mistaken for a different quantity will be, and here it pointed the
investigation at the wrong step. Time spent optimising the wrong thing is a real cost of a bad
metric.

**Result.** Each status line now leads with the delta since the previous line (`+2.1s`) with
cumulative shown quietly beside it, and anything over 3s is highlighted.

**Status.** working.

---

### O-12 · Instrument the gap before optimising it

**Problem.** After O-1, ~6s of the `login` block remained unattributed. `nav_login` measured only
`page.goto(..., { waitUntil: 'domcontentloaded' })` — which returns when the HTML shell parses,
while Progressive's login is an Angular app whose form does not exist for several seconds after
that. The wait was happening inside an unmeasured selector call.

**Options considered.**
1. Assume it is the form render and pre-warm it.
2. Name it as a phase first, then decide.

**Why this one.** (2). Pre-warming was already the likely answer, but an unmeasured cost cannot be
argued about — and an earlier estimate in this exact area was wrong by roughly 3×, which then
mis-sized the expected benefit of O-10. Naming a phase costs one line.

**Result.** `await_login_form`, registered as a child of the `login` composite and labelled in the
metrics UI. Confirms or refutes the estimate on the next real run rather than leaving it inferred
from a status-line delta.

**Status.** working — awaiting its first real-run measurement.

---

## Rejected approaches, and why

Recorded so nobody re-runs these experiments.

| Approach | Why not |
|---|---|
| `fill()` instead of per-character typing | Portals bind validation to `input`/`keyup`; a one-shot set leaves submit disabled. This is why `typeLikeHuman` exists. |
| Type username and password concurrently | One page, one keyboard. Inherently sequential. |
| Parallelise the pull across browser contexts | The flow is a dependency chain: login → challenge → code → documents. There is nothing to run concurrently. |
| Block CSS on Progressive | Playwright visibility is computed from layout; dropping stylesheets makes selectors fail in ways that look like anti-bot. Cheap latency, expensive debugging. |
| Block anti-bot sensor scripts | Akamai/Imperva mint the token that signs the auth request. Blocking the script makes the login POST arrive unsigned. The request you most want to skip is the one you cannot. |
| Lower poll intervals below ~120ms | Marginal gain, and each tick runs locator work in the browser. Not where the time is. |
| Cache documents across sessions | They are someone's declarations page — name, address, VIN, premium. In-memory with a 10-minute TTL is a deliberate choice, not an oversight. |
| Skip `assertNotBlocked()` | It is a few cheap `count()` calls and it converts a 20s timeout plus a misleading "selector not found" into an immediate, accurate error. |
| Pre-warm on a timer | Turns the app into a beacon: dozens of carrier login-page loads per hour from one residential IP with no logins. |
| Reduce `MFA_WAIT_TIMEOUT_MS` to look faster | It is the human's time. Shortening it does not make anything faster, it makes the app fail on slow users. |

---

## Results so far

| | before | after |
|---|---|---|
| Progressive machine time | 23,760ms | **12,736ms** |
| `mfa_submit` | 8,285ms | **1,008ms** |
| `fill_credentials` | ~1,600ms | **719ms** |
| Demo cold path | 3,560ms | **2,062ms** |
| Demo warm path | 495ms | **406ms** |
| Pre-warm adoption | n/a | **4–6ms** (replacing 2.7–19s) |

`mfa_submit` fell 8.2× because almost all of it was blind polling rather than work.

---

## What remains, and why it has not been done

| Item | Estimated | Why not yet |
|---|---|---|
| **Carrier-side credential processing** | ~6.4s | Progressive validating credentials and issuing an SMS. Not ours. Measured and stated, not optimised. |
| **F-19 route-scoped header** | ~2.2s | Would remove the `list_documents_via_page` fallback. Needs a header diff between two routes; F-20's logging now records `sentHeaderNames` to make that possible. |
| **Real-time document path** | unknown | WA-AA's in-force term reports `isEligibleForRealTimeDocument: true`. The adapter only fetches archived copies. May matter more for correctness (current vs most-recently-archived declarations) than for speed. |
| **`await_login_form` reduction** | unknown | Newly instrumented (O-12). Pre-warming already hides it from the user; whether it can also be *reduced* is unmeasured. |

---

## Honest accounting

Two things in this file are worth flagging so they are not read as a clean success story.

**One optimisation broke authentication** (O-6). It was cheap, obviously correct-looking, used
information already in hand, and took down the login flow with a misleading error two phases
downstream. It was caught because the failure bundle recorded the PingFederate flow history — an
observability investment, not a testing one.

**One "optimisation" had never worked at all** (O-5), and its failure was swallowed by a
`.catch(() => {})` while the code reported success to the user. It went unnoticed for the project's
entire history and was only found by asking why a phase was slow. There is no reason to assume it is
the only one of its kind.

---

### O-13 · Keeping O-7's win after it broke the warm path

**Problem.** O-7 moved session persistence off the critical path, and it worked —
107ms of disk and crypto stopped standing between the PDFs arriving and the user
seeing them. It also silently disabled the largest optimisation in the entire
system.

Measured, on two back-to-back demo pulls:

| | |
|---|---|
| Run 2 machine time | **2,400ms** |
| Run 2 `warmPath` | **false** |
| Run 2 phases | full `login` + `mfa_wait` + `mfa_submit` |

Run 2 should have been a warm rehydrate: no login, no MFA, ~0.6s. It performed a
complete cold login instead. Full diagnosis in F-34; the mechanism is that
`COMPLETED` is sent to the client before the save lands, so a pull starting
immediately afterwards reads the store during the window between the stale
session being deleted and the new one being written.

**Why O-7 did not catch it.** O-7 was verified by checking that
`persist_session` still appeared in the metrics after being backgrounded — it had
briefly vanished, which was a real bug, and fixing that felt like completing the
work. But that check only confirmed the *writer* still functioned. Nothing
checked a *reader*. The verification matched the shape of the change rather than
the shape of the risk.

**Options considered.**

1. **Await the save before emitting `COMPLETED`.** Guaranteed correct, and it
   throws away exactly what O-7 bought. Rejected: it reverts a good optimisation
   to fix a narrow race.
2. **Accept it as a test artefact.** Tempting, since a human will not pull twice
   in 200ms. Rejected — the assertion is legitimate, and the cost when it does
   happen is not 107ms but a second login and a second *human* MFA round-trip.
   Scale changes the argument: the human wait is the largest single cost in the
   budget, so anything that causes an avoidable extra one is expensive.
3. **Have the store track in-flight saves, and make `load()` await a pending save
   for the same key.**

**Why (3).** It is the only option that keeps both properties. The waiting is paid
solely by a caller who would otherwise have read a missing file — which is
precisely when waiting is the correct behaviour — while the first pull's
user-facing path is still never blocked. O-7's benefit survives intact and the
correctness hole closes.

One implementation detail is load-bearing: `save()` registers its promise
**synchronously** before awaiting anything. Registering inside the async body
would leave a window where the save has started but is not yet discoverable,
which is the same bug one level down.

**Result.**

| | before | after |
|---|---|---|
| Run 2 machine time | 2,400ms | **623ms** |
| Run 2 warm path | false | **true** |
| Run 2 login + MFA | performed | **skipped** |
| `persist_session` on critical path | no | **still no** |

A 3.9× improvement on a repeat pull, recovered rather than gained — the capability
already existed and had stopped working.

**Status.** working. O-7 stands; this is the missing half of it.

**What this changes about how to optimise here.** Two entries in this file now
share one shape. O-6 read a status *before* the state could advance; O-7 wrote a
file *after* a reader could look for it. Both were reorderings that were correct
from the perspective of the code being changed and wrong from the perspective of
something else that touched the same state.

So, added to [Method](#method) in practice: **when an optimisation changes when
something happens, enumerate every reader of the thing being reordered, not just
the writer.** Neither of these would have survived that question being asked out
loud. It is also why the "verify the postcondition" rule needs a companion — O-7's
postcondition (`persist_session` still measured) was genuinely satisfied while the
optimisation was actively breaking a different feature.

**And a note on how it surfaced.** Not by any check attached to O-7, but by
`npm run smoke` during an unrelated regression sweep for a second carrier, two
features later. The failing assertion was `used warm path (no login, no MFA)` —
one line, in a suite that could easily have been skipped on the grounds that
nothing related had changed.

---

### O-14 · Hiding the pre-warm from the user, without hiding it from ourselves

**Problem.** Not a latency problem — a *reporting* one, and it belongs here because it is about
how an optimisation is presented rather than how it performs.

O-10 introduced the pre-warmed page pool, and with it a status line:

```
Reusing a pre-opened carrier tab, skipping page load.
```

A user reported that this should not be visible, because it describes a technique used to reduce
browser open time. They were right, and the wording made it worse than merely irrelevant:
**"reusing"** and **"skipping"** both read like corner-cutting to somebody watching their own
login happen. A line describing an optimisation working perfectly sounded like something being
bypassed.

**Options considered.**

1. **Delete the line.** Simplest, and it destroys the only evidence the optimisation fired.
   Pre-warm adoption has been confirmed from that exact string repeatedly while debugging, and
   `adopt_prewarmed` timing alone does not distinguish "adopted in 4ms" from "no page was parked
   and the phase recorded 0ms".
2. **Two message sets**, one for the UI and one for logs. Doubles where a message lives and
   guarantees drift: the log line gradually stops describing what the UI shows, and the next
   person debugging trusts the wrong one.
3. **One line, marked internal**, kept in the timeline and withheld from the live UI stream.

**Why this one.** (3). The timeline already feeds the logs, the failure bundle and
`/api/sessions/:id` — everything an operator reads — while only the live `note` event reaches the
browser. So the split already existed structurally; it just had no switch. One flag on one call
site serves both audiences with no duplicated text to diverge.

**Result.** `note(message, detail, { internal: true })`. Verified rather than assumed:

```
notes in timeline      : 2   (both retained)
emitted to the UI      : 1   (internal withheld)
internal flag preserved: true
```

Three lines are now internal — both pre-warm adoption notices and the document-list fallback route.
`· pre-warmed page` also came out of the results footer, for the same reason; `prewarmed` remains in
`/api/sessions/:id` and the metrics, which is where anyone measuring the optimisation looks.

**Status.** working.

**What this changes about presenting optimisations.** An optimisation that announces itself is
making a claim to somebody who cannot evaluate it. The user cannot tell whether reusing a tab is
good, and the phrasing suggested it was not. Worth applying to the rest: a status line containing a
word from the architecture — pool, tab, cache, state, session store — is describing the
implementation rather than the user's situation.

The same audit reworded four more lines that were debug output which happened to be rendered:
*"Saved session still valid. Skipping sign-in and verification"* became *"Still signed in. No
password or code needed."* Same event, and the second one tells them the thing they actually want
to know — whether they are about to be asked for a password.

**A note on measurement.** None of this changes a number. It was worth doing anyway, because O-11
recorded the inverse case: a metric displayed badly (cumulative elapsed read as a step duration)
sent an investigation at the wrong step entirely. Presentation of performance information has cost
real time in this project in both directions — once by hiding a cost, once by advertising one that
needed no audience.

---

### O-15 · Measured research on the whole critical path, both carriers working

**Problem.** Both carriers now complete end to end, so for the first time there is real
per-phase data for a full GEICO pull rather than estimates. The question asked: which steps can
be removed, made asynchronous, or overlapped.

**Method.** Read `data/metrics.jsonl` — 194 recorded runs, of which **1 complete GEICO** and
**5 complete Progressive**. One successful GEICO run is a thin sample and every number below
should be read as one observation, not a distribution. It is enough to rank the opportunities,
which is what was asked; it is not enough to claim a 200ms improvement.

---

#### Step 1 — the instrumentation was wrong twice, again

Per [Method](#method) rule 4, suspect your own measurements first. Two faults, both inflating
the reported figure:

**`mfa_submit` was double-counted.** The recorded GEICO run contains the phase twice, with
identical durations:

```
{"phase": "mfa_submit", "durationMs": 1949}
{"phase": "mfa_submit", "durationMs": 1949}
```

`pullSession` measures `mfa_submit_${attempt}`, the metrics store normalises that suffix back to
`mfa_submit`, and the GEICO adapter wrapped the *same span* again under that exact name. The
outer measurement is the correct one — it spans the retry loop, so it survives a rejected code
where an inner phase would record only the final attempt. The adapter's wrapper is removed.

Progressive never showed this because its adapter does not wrap the call. A convention that
existed only by accident.

**`persist_session` was counted as latency the user waited on.** O-7 moved the session save off
the critical path, and it works — the COMPLETED payload is sent before the save completes. But
metrics are sealed in `finally`, after `#cleanup()` awaits that save, so `wallMs` extends past
delivery. On this run, by **577ms**.

So the headline was *pessimistic about our own performance*: 13,285ms reported for a run where
documents were on screen at roughly 12,708ms. O-3 took care that the windows never report lower
than reality; this is the same concern inverted, and it is still a number that does not describe
what the user experienced. `machineMs` now subtracts phases flagged post-delivery, and
`postDeliveryMs` is surfaced so the subtraction is auditable rather than hidden.

**Corrected GEICO machine time: 12,605ms** (from 13,285ms). Both corrections made the system
look *better*, which is the direction a measurement bug is least likely to be noticed from.

---

#### Step 2 — where the 12,605ms actually goes

| phase | ms | % | owner |
|---|---|---|---|
| **`list_documents`** | **4,948** | **39%** | **ours** |
| `submit_credentials` | 2,975 | 24% | carrier — auth, chooser render, OTP send |
| `mfa_submit` | 1,949 | 15% | carrier — validates the code |
| `document_download` | 1,476 | 12% | carrier — generates and sends the PDF |
| `fill_credentials` | 1,223 | 10% | ours |
| `adopt_prewarmed` + `nav_login` + `await_login_form` | 34 | 0% | ours, already solved |

Roughly **49% ours, 51% carrier-side**. And separately: the browser is **idle for the entire
11,821ms** of human MFA wait.

The pre-warm work (O-10) is fully validated here. `nav_login` 12ms and `await_login_form` 19ms
on a carrier whose app takes 2,292–6,177ms to mount cold — the user pays none of it.

---

#### Step 3 — the finding: we boot an entire app to read one JSON response

Comparing the two carriers' document phases identifies the cause precisely:

| | GEICO | Progressive |
|---|---|---|
| `nav_documents` | — | **302ms** |
| `list_documents` | **4,948ms** | 348ms |

Progressive's 302ms is an **SPA route change inside an app that is already running**. GEICO
serves documents from `edgecustomer.geico.com` — a **different origin** from the `ecams` login
host — so arriving there forces a **cold Flutter boot**, measured between 2,292ms and 6,177ms.

Almost all of the largest item on the critical path is a single-page application starting up so
that we can read one API response we already know the shape of.

---

#### Step 4 — candidates, ranked by (value ÷ risk)

**A. Call the API directly, skip the app. IMPLEMENTED.**

`POST /ws/bootstrap` then `GET /ws/consolidated-documents` through `context.request`, which
shares the session cookies. Every GEICO host bootstraps its own origin — `ecams`, `portfolio`
and `edgecustomer` each call it — which is very likely why a cold list call previously returned
401.

Chosen first because the trade is asymmetric and the risk is zero:

- costs ~300–500ms when it fails
- saves ~4,500ms when it works
- is a **pure fallback** — on any failure, including a 200 with no `policyNumber`, the existing
  navigation runs unchanged

Requiring `policyNumber` rather than accepting a 200 is F-13 generalised: a success status is not
evidence of a useful body, and a bootstrap-only response returning an empty payload would
surface as "no documents found", which reads like an account problem rather than a shortcut that
did not work.

Unverified against a real session — it needs an authenticated GEICO login to exercise. The log
line `DIRECT document list succeeded` or `...declined` will say which on the next run.

**B. Pre-boot the documents host during the MFA wait. NOT IMPLEMENTED — deliberately.**

The browser is idle for 11.8 seconds while a human reads a text message. Loading
`edgecustomer.geico.com` in a second page during that window would have its Flutter bundle
parsed and cached before the authenticated navigation needs it, plausibly removing 2–6s.

Not shipped, because the risk is real and unmeasured: a second page shares the context's cookie
jar, and an **unauthenticated** visit to the documents host could set or clear state that breaks
the authenticated visit that follows. The failure would appear after the user has already entered
their code — the most expensive moment in the flow to break something.

This is O-6's lesson applied before rather than after: that optimisation was also obviously
correct-looking, also touched authentication state, and took down the login flow. The difference
between a good idea and a shipped one is a test, and this one cannot be tested without a real
login.

Recommended as the next experiment if (A) does not work. If it is tried, use a separate browser
context rather than a second page — no shared cookie jar — and measure whether the HTTP cache is
still shared enough to help.

**C. `fill_credentials` 1,223ms. NOT WORTH IT.**

35 characters at the tuned ~22ms average is ~770ms, and the remainder is clicks, field clears and
read-back verification. Halving the delay saves ~380ms and further weakens the behavioural story
O-4 already traded down once. The read-back is what caught F-39's dropped keystroke and F-42's
corrupted code; removing it to save time would trade a silent-corruption guard for 5% of the
budget. Declined.

**D. The remaining 51% is carrier-side.** `submit_credentials` covers GEICO authenticating,
rendering the chooser and dispatching an SMS; `mfa_submit` is GEICO validating a code;
`document_download` is GEICO generating a PDF. Measured and stated, not optimised — consistent
with [Method](#method) step 2.

---

**Status.** (A) implemented and awaiting a real run. Instrumentation corrections verified by
`npm run test:windows`, which still passes — the subtraction is safe against O-3's
double-counting trap because `persist_session` is a leaf and wraps no children.

**Lesson.** The most useful thing in this analysis was the **cross-carrier comparison**, not the
GEICO numbers alone. `list_documents: 4,948ms` looks like an unremarkable network cost until
Progressive's equivalent step reads 302ms, at which point it is obviously a cold app boot that
should not be on the critical path at all. A second implementation of the same problem is the
cheapest benchmark available, and this project had one sitting in the same metrics file.

Also worth noting: both instrumentation faults made the system look *worse* than it was. A
measurement error in that direction never gets challenged, because nobody investigates a number
that flatters them less than reality.

---

### O-16 · Making O-15's "pure fallback" a property of the code, not a claim about it

**Problem.** O-15's first candidate — `#tryDirectDocumentList()`, skipping the cold Flutter boot
on `edgecustomer` by calling `POST /ws/bootstrap` then `GET /ws/consolidated-documents` directly —
was justified on an asymmetry: roughly 300-500ms spent when it fails against ~4,500ms saved when
it works. That arithmetic only holds if failure really costs *only* time.

**It did not, quite.** `context.request` shares the browser context's cookie jar. So a probe that
gets partway — bootstrap accepted, list declined — can leave `edgecustomer.geico.com` holding a
session the page never asked for, and the page then navigates into it. The failure mode is not a
slow pull, it is a pull that fails in a way that looks like a carrier problem. This is O-6's
lesson exactly: a shared jar means an "isolated" request is not isolated.

The method's own docstring claimed *"an optimisation that can turn a working pull into a failed
one is not worth having"*. The claim was right and unenforced.

**Chosen: snapshot the origin's cookies, roll back on any non-success.** Capture the documents
origin's cookies before the probe, and on every failure path restore them. Failure paths are the
declined bootstrap, the declined list, the 200-without-a-`policyNumber` case, and the `catch`.

**Scoped to host-only cookies, deliberately.** `context.cookies(url)` also returns cookies set on
the parent `.geico.com`, and those are shared with the authenticated login host. Clearing them to
tidy up a failed probe would risk destroying the session the pull depends on — a cleanup worse
than the mess. Rollback therefore matches `^\.?edgecustomer\.geico\.com$` and leaves parent-domain
cookies alone. Restoring less than everything, in the safe direction, beats restoring too much.

**Two details worth stating:**

- The rollback compares before and after, and skips the clear entirely when nothing changed.
  The common case is the probe changing no host cookies at all, and churning the jar to
  "restore" an identical state is pure risk for no benefit.
- If the snapshot itself fails, the probe still runs. The undo is lost, not the attempt —
  and that is logged, so a run with a weaker guarantee is visible rather than assumed.

**Cost.** Two local cookie reads, no network. Does not move the measured critical path.

**Not yet verified against a real session.** Whether the bare bootstrap mints the session the
list endpoint wants is still the open question from O-15; a 401 was observed previously without
the app's own `sessionkey` / `edge-policy-token` / `x-xsrf-token` headers. The next real GEICO run
decides it — look for `DIRECT document list succeeded` against `… declined` in the log. What this
entry changes is only the cost of being wrong.

**Lesson.** "It is a pure fallback, so the worst case is the current behaviour plus a bit of
latency" is a claim about shared state, and it was made without checking the shared state. The
shortcut and the normal path were using the same cookie jar the entire time. When an optimisation
is defended on the grounds that failing is cheap, the thing to audit is not the timing but
everything the failed attempt can leave behind.

---

### O-17 · Choosing the proxy auth mode, and declining the one that looks more secure

**Not a latency entry.** Recorded here because it is a deliberate engineering choice with a
tradeoff, and the rejected option is the one that sounds better.

**The choice.** Proxy-Cheap offers two authentication modes, confirmed live:

```
GET /proxies/{id}/change-authentication-type
{"currentAuthenticationType":"USERNAME_PASSWORD",
 "availableAuthenticationTypes":["IP_WHITELIST","USERNAME_PASSWORD"]}
```

`available` reads like "you may also add", and it is not. They are mutually exclusive:
switching to `IP_WHITELIST` **revokes** the username and password rather than adding a second
route in.

**Chosen: `USERNAME_PASSWORD`, unchanged.**

**Rejected: `IP_WHITELIST`,** despite it being the stronger posture in the abstract — it takes
the proxy password out of the container environment entirely, so a compromised task leaks
nothing reusable. Three reasons it is wrong *here*:

| Reason | Detail |
|---|---|
| It is a one-way door | Because the modes are exclusive, a whitelist that does not match the real egress address locks the proxy out completely, and the only way back is the management API — the credential that is deliberately *not* deployed. |
| The deployment target moves | An ECS Fargate task gets a new public address every replacement. `desiredCount = 1` with rolling restarts means that is every deploy. The whitelist would break on each one. |
| Local development moves | A home connection's address is reassigned by the ISP without notice. |

**When it becomes the right answer.** Once egress is pinned behind a NAT Gateway with an
Elastic IP, the address is genuinely fixed and every objection above disappears. At that point
whitelisting is strictly better than credentials. So it is a **post-deploy hardening step,
conditional on the NAT EIP existing** — not a setup step. Written up in
`docs/aws-deployment.html` rather than applied now, because applying it before the EIP exists
would break the working configuration to gain a benefit that depends on infrastructure that
is not yet built.

**A related choice: three proxies, one configured.** The account holds three dedicated
`RESIDENTIAL_STATIC` IPs, each with its own credentials. `proxy:discover` pins one rather than
distributing across them. Rotating between three would mean a returning user arriving from a
different address each pull, which is a worse signal to a carrier than always arriving from
the same one. Per-carrier pinning — GEICO always on IP 1, Progressive always on IP 2 — is
genuinely attractive, since it adds fault isolation while keeping per-carrier consistency, and
is **not implemented**: it touches the working proxy path for a benefit that only materialises
once one IP is actually flagged. Recorded as the obvious next step rather than done
speculatively.

**One finding that no dashboard would have shown.** All three proxies have
`autoExtendEnabled: true`, which looks like the "nothing gets dropped" requirement is met. The
account balance is **0**. Auto-extend renews by charging account balance, so the flag is on and
guarantees nothing — the renewal will fail on the day it runs. `proxy:verify` now fails on
exactly that combination, and distinguishes it from a routing fault in its summary, because
"the routing works but the account will lapse" and "traffic is leaving from the wrong place"
need completely different responses.
