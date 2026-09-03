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

Each subcommand is a routed stub in this slice — correct usage text and exit codes; later build tickets replace the bodies. Exit codes: `0` ok/help · `1` config error · `2` usage error (unknown subcommand, bare invocation).

**LLM configuration — environment only, never flags, never logged.** Startup validation is cheap and loud and runs before anything else: a malformed or missing config fails before any subcommand work, naming the env var — never the value.

| Variable | Meaning | Default |
|---|---|---|
| `WRAPPER_OLLAMA_BASE_URL` | OpenAI-compatible endpoint base URL; tests point it at a stub server (the interception seam, FYR-325) | `https://ollama.com/v1` |
| `WRAPPER_MODEL_MAIN` | Main model id | `glm-5.3-flash:cloud` |
| `WRAPPER_MODEL_FALLBACK` | Fallback model id — engaged on failure only, never on a validating output (`n_fallback = 1`) | `glm-5.3:cloud` |
| `WRAPPER_OLLAMA_API_KEY` | Ollama Cloud API key (required; never printed or persisted) | — |
| `OPENAI_API_KEY` | Presence only (value unread) gates the third-tier escalation valve (FYR-257) | — |

All wrapper code is ESM (`.mjs`); the bin needs no build step. The seam later tickets reuse: a test harness spawns the bin against a stub HTTP server by overriding `WRAPPER_OLLAMA_BASE_URL` and asserts on stdout/exit only — see `test/cli-skeleton.test.mjs`.

## Tests

`npm test` (`node --test`) — suites: `test/drift-guard.test.mjs`, `test/id-match.test.mjs`, `test/plan-parse.test.mjs`, `test/cli-skeleton.test.mjs` (bin spawned end to end against a stub server).
