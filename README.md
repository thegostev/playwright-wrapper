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

## Tests

`npm test` (`node --test`) — drift-guard suite in `test/drift-guard.test.mjs`.
