# Spike: step-id roundtrip (FYR-267)

**Result: PASS (17/17 checks), zero model** — run with `node spike/step-id-roundtrip/run.mjs` from the repo root.

## What it proves

That the generator-output contract is *implementable* — that a generated spec's
steps are addressable for the FYR-250 healer (`{step_id, locator}`) using stock
Playwright's JSON reporter and text surgery only:

1. **Read half.** Every plan step is one `test.step('[sN] <action>', …)`; the id
   rides the title. On failure, `results.json` carries the error on the
   enclosing `test.step` node (verified at runtime, not from the type defs),
   and the reporter emits **only** `test.step` entries — the outermost step
   matching `^\[(s\d+)\]` is the failure's address. Unexecuted steps don't
   appear (steps present == steps attempted).
2. **Write half.** `[s4]` scans to a unique anchor; the one-slot rule puts
   exactly one locator expression in the step body; the literal-only grammar
   makes it one-line regex surgery. Patch → rerun → the test passes, all ids
   untouched, the patched spec still passes the lint.
3. **The refusals.** A duplicate token makes the patch scan ambiguous → loud
   refusal. A step with no token fails the spec lint → refusal before any
   patch. A heal patcher that only ever succeeds has not been tested.

## Setup

`run.mjs` generates a throwaway consumer project (`consumer/`, gitignored): the
hand-crafted plan (`sign-in.plan.md`), its stamped spec (`// plan-sha256:` first
line, recomputed and verified), a consumer `playwright.config.ts` carrying the
four-part config contract (testDir, baseURL from env, captureGitInfo, JSON
reporter), and a tiny local site (login page → dashboard) served over HTTP.

The shipped spec contains one intentional defect: `[s4]`'s locator names a
button `Log in` while the page says `Sign in` — that failure is the spike's
object under test.

Traces from the last run: `spike/traces/fyr267-fail-results.json`,
`spike/traces/fyr267-pass-results.json`.

## What it does not prove

That a **generator** (an LLM) can *produce* this encoding. The pair is
hand-crafted; the spike shows the encoding round-trips, nothing more. The
generator's emission discipline is the generator ticket's proof.
