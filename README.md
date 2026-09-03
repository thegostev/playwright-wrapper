# playwright-wrapper
Playwright for agentic efficiency. Use cases from browsing and scraping to E2E tests.

## Drift guard (FYR-302)

Healing a report produced by a commit other than the local checkout is how a locator patch gets applied to an app that moved — the patch looks successful and is wrong. Before any heal work, the wrapper refuses when the report's commit does not match the local HEAD.

The mechanism, end to end:

1. **Consumer side (one line):** the consumer repo's `playwright.config.ts` sets `captureGitInfo: true` (it defaults to `false` outside CI). The CI `results.json` then carries the commit SHA in its git metadata.
2. **Run-id carries the SHA:** a heal run's folder is `playwright-output/<project>/<run-id>/` with `<run-id>` = `YYYY-MM-DDTHHmmssZ-<sha7>` — the SHA is in the name so the guard reads it without opening anything (FYR-251 placement rule).
3. **The check:** run-id SHA vs local HEAD. Mismatch → refuse (exit 1).
4. **Override:** `--drift-ok=<sha>` — value-bearing, pinned to the report's exact SHA. It must be constructed from the SHA being overridden; if the report's SHA changes underneath, the override no longer matches and the guard refuses again. The refusal message states the mismatch and never names the override, so a model-invoked skill can't reflexively append it.

```sh
node src/drift-guard.cli.mjs <run-id|run-folder> [--drift-ok=<sha>]
```

Run from the consumer repo (local HEAD is resolved from the current directory).

| run-id SHA vs local HEAD | without override | with `--drift-ok=<same-sha>` |
|---|---|---|
| matches | proceed (exit 0) | proceed (exit 0) |
| differs | **refuse** (exit 1) | proceed (exit 0) |
| differs + override stale (report SHA changed) | — | **refuse** (exit 1) |

The heal flow embeds `checkRunDrift()` from `src/drift-guard.mjs` as a pre-gate; the CLI entry exists so the check is invocable and testable on its own.

## CLI (FYR-326 — v1-build 1)

The product surface: a runnable bin that routes the four subcommands and reads its entire LLM configuration from the environment.

```sh
playwright-wrapper <plan|generate|heal|browse> [--help]
```

Each subcommand routes and validates before dispatch; exit codes: `0` ok/help · `1` config error · `2` usage error (unknown subcommand, bare invocation). `plan` (FYR-329), `generate` (FYR-330), `browse` (FYR-333), and `heal` (FYR-331) have real bodies; see their sections.

**LLM configuration — environment only, never flags, never logged.** Startup validation is cheap and loud and runs before anything else: a malformed or missing config fails before any subcommand work, naming the env var — never the value.

| Variable | Meaning | Default |
|---|---|---|
| `WRAPPER_OLLAMA_BASE_URL` | OpenAI-compatible endpoint base URL; tests point it at a stub server (the interception seam, FYR-325) | `https://ollama.com/v1` |
| `WRAPPER_MODEL_MAIN` | Main model id | `glm-5.3-flash` |
| `WRAPPER_MODEL_FALLBACK` | Fallback model id — engaged on failure only, never on a validating output (`n_fallback = 1`) | `glm-5.3` |
| `WRAPPER_OLLAMA_API_KEY` | Ollama Cloud API key (required; never printed or persisted) | — |
| `OPENAI_API_KEY` | Presence only (value unread) gates the third-tier escalation valve (FYR-257) | — |

All wrapper code is ESM (`.mjs`); the bin needs no build step. The seam later tickets reuse: a test harness spawns the bin against a stub HTTP server by overriding `WRAPPER_OLLAMA_BASE_URL` and asserts on stdout/exit only — see `test/cli-skeleton.test.mjs`.

## Heal (FYR-331 — v1-build 6, ladder rung 1)

`heal` walks one ladder notch over a **self-locating run** — a run folder that holds its own `results.json`, named `YYYY-MM-DDTHHmmssZ-<sha7>`:

```sh
playwright-wrapper heal <run-folder> [--drift-ok=<sha>]
```

Order of operations, all boundary validation **before any model call**:

1. **Drift guard** (FYR-302): run-id SHA vs local HEAD; the refusal never names the bypass flag.
2. **Trace parse:** the stock Playwright JSON report is the only ground truth. The failing step's address is the outermost `test.step('[sN] …')` node carrying an error — no source-location fallback (FYR-267: the JSON reporter carries only `test.step` entries). Unexecuted steps are absent; present = attempted.
3. **Version coupling** (FYR-249): the report's Playwright version must be known and in the same major as the local `@playwright/test`.
4. **Outcome routing** (FYR-250): the five statuses pass through un-inferred; `outcome_class` is derived — only `not_pass` enters the loop (`no_verdict` never heals), a `compile`-stage failure is refused (the ladder addresses run/assert failures only), and a passing run is `nothing_to_heal`.
5. **Pair check:** the failing spec must satisfy the generator-output contract and carry its stamped `.plan.md` beside it — heal patches generated pairs only.

Rung 1: the bridge takes a **fresh** page snapshot (target URL = the consumer config's `baseURL` + the plan's `go to` path) and the main model returns **data, not code** — one JSON object `{step_id, locator}` or nothing. Proposals are validated unmodified:

- **banned** — the model violated the contract (unknown step id, grammar-rejected locator, extra/code-shaped fields, or a proposal targeting a step other than the failing one)
- **stuck** — the model could not or did not answer (empty, unparseable, declared no locator, or the LLM tiers both failed)

Neither is ever repaired, fence-stripped, or retried — refusals are outcomes, not exceptions.

The patch is **text surgery** on the spec's single locator slot (one of the three compiler emission shapes), with a compile-stage safety net (`node --experimental-strip-types --check`): a failing patch is **reverted** — a broken spec is never left.

Artifacts:

- **`.heal.md`** beside `results.json` for every non-pass outcome: the trace-derived failure address, the ladder rungs with the stuck-vs-banned classification, attempt counts, and the fresh page snapshot.
- **Envelope** on stdout — `contract_version: 2`, `outcome` ∈ `healed | no_proposal | compile_failed | nothing_to_heal`, `attempts: {n_primary, n_fallback, third_tier}`, the patch `{step_id, old_locator, new_locator, changed}`, and `verified: false` — heal never claims the suite now passes; verification is the consumer's rerun.

Exit: `healed` / `nothing_to_heal` → 0; `no_proposal` / `compile_failed` → 1.

## Tests

`npm test` (`node --test`) — suites: `test/drift-guard.test.mjs`, `test/id-match.test.mjs`, `test/plan-parse.test.mjs`, `test/cli-skeleton.test.mjs` (bin spawned end to end against a stub server), `test/plan.test.mjs`, `test/generate.test.mjs`, `test/trace-parse.test.mjs`, `test/heal.test.mjs` (stub LLM at the API boundary + real browser against local pages), `test/browse-core.test.mjs`, `test/browser-bridge.test.mjs`, `test/roundtrip.test.mjs`.
