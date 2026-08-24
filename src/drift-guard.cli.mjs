#!/usr/bin/env node
// Standalone drift-guard check (FYR-302) — run from the consumer repo.
//
// The heal flow embeds this as a pre-gate; this entry exists so the check is
// invocable and testable on its own. Exit 0 = heal may proceed, exit 1 =
// refused. The refusal text goes to stdout (it is the command's output); usage
// errors go to stderr.

import { checkRunDrift } from './drift-guard.mjs';

const FLAG = '--drift-ok=';

function usage() {
  return [
    `usage: playwright-wrapper drift-guard <run> [--drift-ok=<sha>]`,
    ``,
    `  <run>            a heal run-id (YYYY-MM-DDTHHmmssZ-<sha7>), or the path`,
    `                   to its folder — the SHA is read from the name,`,
    `                   nothing is opened`,
    `  --drift-ok=<sha> proceed despite drift, pinned to this report's exact`,
    `                   SHA (7 or 40 hex digits); constructed from the SHA`,
    `                   being overridden`,
    ``,
    `Run from the consumer repo. The report's run-id SHA is compared to the`,
    `local HEAD; on mismatch heal refuses.`,
  ].join('\n');
}

function parseArgs(argv) {
  const flags = argv.filter((a) => a.startsWith(FLAG));
  if (argv.some((a) => a === '--drift-ok')) {
    return { error: 'the bypass flag must be value-bearing: --drift-ok=<sha>' };
  }
  if (flags.length > 1) {
    return { error: '--drift-ok may be given at most once' };
  }
  const rest = argv.filter((a) => !a.startsWith(FLAG));
  if (rest.length !== 1) {
    return { error: `expected exactly one <run> argument, got ${rest.length}` };
  }
  return { run: rest[0], override: flags.length ? flags[0].slice(FLAG.length) : undefined };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${usage()}\n`);
    process.exit(2);
  }
  const result = checkRunDrift({ run: parsed.run, cwd: process.cwd(), override: parsed.override });
  if (result.ok) {
    if (result.note === 'override') {
      process.stdout.write(`drift check passed: run ${result.runSha} is not HEAD, proceeding on the override pinned to it\n`);
    } else {
      process.stdout.write(`drift check passed: run ${result.runSha} matches local HEAD ${result.headSha.slice(0, 7)}\n`);
    }
    process.exit(0);
  }
  process.stdout.write(`${result.message}\n`);
  process.exit(1);
}

main();
