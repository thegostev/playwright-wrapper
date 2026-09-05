# Spike: login-cost measurement (LAG-573)

**Result: measured, zero model** — run with `node spike/login-cost/run.mjs` from the repo root.

## What it measures

The trigger [LAG-548](https://linear.app/lage/issue/LAG-548) names, so the v2
storageState/setup-project piece is bought with numbers or stays parked. Two
variants of the same generated suite on the same local site:

- **v1 (login-as-steps)** — every test opens with the demo plan's login
  sequence (`[s1]` goto, `[s2]`/`[s3]` fill, `[s4]` submit) before its
  dashboard assertions (`[s5]` heading, `[s6]` orders cell). This is the
  shipped v1 answer: login as ordinary plan steps, `env:` credentials,
  `storageState` banned by the spec lint.
- **setup project** — stock-Playwright `setup` project logs in once and saves
  `page.context().storageState()`; an `e2e` project depends on it and injects
  `use: { storageState }`, so the generated tests drop the login steps. The
  setup spec is infrastructure, not a plan — it is the only spec in the spike
  that mentions `storageState`, and it deliberately fails the generated-spec
  lint (the runner asserts that it does).

Per run: process wall-clock, JSON-report test time, and the per-step durations
the JSON reporter already carries (login steps vs post-login steps). Per
variant × suite size: one warmup run discarded, then 5 timed runs. **Flakiness
is counted, not classified**: `non-pass` = non-zero exit or
unexpected/flaky/skipped > 0. No retries anywhere.

## The honest parts

- **The site has real cookie sessions** (`POST /login` → `Set-Cookie`,
  `/dashboard` requires the cookie). A static site with client-side-only auth
  would make `storageState` a no-op and the comparison dishonest. Credentials
  are env-only (`E2E_USER`/`E2E_PASSWORD`, dummy values, never logged).
- **The setup variant's tests do the same post-login work as v1's tests** —
  goto + the same two assertions — so the wall-clock delta is the login steps,
  nothing else. The one-time setup login is *inside* the setup variant's
  wall-clock, not amortized away.
- **Local loopback underestimates real-world login flakiness** (network, SSO
  redirects, rate limits). The count is still the count.
- **The suite is one spec file with N tests sharing the login-opening plan
  shape** — the stand-in for N generated plans each opening with the same
  login sequence.

## Setup

`run.mjs` generates throwaway consumer projects (`consumer/`, gitignored):
plan + stamped spec (`// plan-sha256:` first line) + config per variant, and a
tiny cookie-session site served in-process. The generated plans pass
`checkPlan`, the generated specs pass `lintSpec` (v1 keeps its env closure;
the setup variant's specs contain no `storageState`), and the runner refuses
to start if the grammar honesty checks fail.

Config via env: `SPIKE_SIZES=10,50` (tests per suite), `SPIKE_RUNS=5` (timed
runs per variant × size). Numbers land in `results/summary.json`.

## What it does not prove

That v2 should be built — the numbers only *recommend*; LAG-548's own text
sets the bar. And nothing here touches the wrapper: no heal/plan/browse
machinery, no grammar changes, no `storageState` handling outside the spike.