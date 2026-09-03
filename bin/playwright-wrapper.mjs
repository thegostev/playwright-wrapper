#!/usr/bin/env node
// playwright-wrapper bin (FYR-326): routes the four subcommands and validates
// the env-only LLM config at startup — cheap and loud, before anything else.
// Subcommands are stubs in this slice: correct usage text + exit codes.

import { loadConfig, USAGE, ConfigError } from "../src/config.mjs";

const SUBCOMMANDS = ["plan", "generate", "heal", "browse"];

const SUBCOMMAND_USAGE = {
  plan: `playwright-wrapper plan — emit a candidate plan from a live page snapshot

Usage:
  playwright-wrapper plan [options]

Reads the task spec (target + NL goal + profile header), drives the page in a
real Chromium via the in-process Playwright MCP bridge, snapshots it, and has
the main model emit a keyed-line plan. The plan prints to stdout for review.
(Not implemented yet — this slice ships the routing and config surface.)`,
  generate: `playwright-wrapper generate — compile an approved plan into a stamped spec pair

Usage:
  playwright-wrapper generate < plan.md

Consumes the approved plan verbatim on stdin, validates it against the
generator-output contract, and writes the stamped pair (.spec.ts first line
stamped with the plan sha256 + .plan.md) into the consumer repo.
(Not implemented yet — this slice ships the routing and config surface.)`,
  heal: `playwright-wrapper heal — walk the heal ladder over a self-locating CI run

Usage:
  playwright-wrapper heal [run-folder]

Consumes a self-locating run (results.json beside the record), derives the
outcome from the trace, proposes {step_id, locator} patches via the ladder,
and writes a .heal.md record for every non-pass outcome.
(Not implemented yet — this slice ships the routing and config surface.)`,
  browse: `playwright-wrapper browse — planless ReAct loop ending in submit_extraction

Usage:
  playwright-wrapper browse

Runs the browsing loop over the real page, judged by the structural oracle,
and emits the contract-version 2 outcome envelope on stdout.
(Not implemented yet — this slice ships the routing and config surface.)`,
};

function printHelp(toStdout = true) {
  const out = toStdout ? process.stdout : process.stderr;
  out.write(USAGE + "\n");
}

/**
 * Route + validate. Returns the process exit code.
 * @param {string[]} argv - process.argv.slice(2)
 * @param {NodeJS.ProcessEnv} env
 */
export async function run(argv, env = process.env) {
  const [first, ...rest] = argv;

  if (first === "-h" || first === "--help" || first === undefined) {
    printHelp(first !== undefined);
    if (first === undefined) return 2; // bare invocation: usage on stderr, exit 2
    return 0;
  }

  if (!SUBCOMMANDS.includes(first)) {
    process.stderr.write(
      `playwright-wrapper: unknown subcommand "${first}"\n\nExpected one of: ${SUBCOMMANDS.join(", ")}, or --help.\n\n`,
    );
    printHelp(false);
    return 2;
  }

  if (rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(SUBCOMMAND_USAGE[first] + "\n");
    return 0;
  }

  // generate is model-free: it consumes approved plan bytes. The LLM config
  // gate is irrelevant here — dispatch BEFORE the config validation, since
  // a test consumer has no Ollama key.
  if (first === "generate") {
    const { generateMain } = await import("./lib/generate.mjs");
    return generateMain();
  }

  // Startup validation: cheap and loud, before any subcommand work.
  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`playwright-wrapper: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  // Stub dispatch — later tickets replace these bodies. The config is loaded
  // and valid; say what will run and exit clean. Never print key values.
  const thirdTier = config.thirdTierKeyPresent
    ? "third-tier valve enabled (OPENAI_API_KEY present)"
    : "third-tier valve disabled (OPENAI_API_KEY absent)";
  process.stdout.write(
    `playwright-wrapper ${first}: config OK — endpoint ${config.baseUrl.origin}, ` +
      `main ${config.modelMain}, fallback ${config.modelFallback} (fallback on failure only), ${thirdTier}.\n` +
      `${first} is not implemented yet (v1-build ticket FYR-326: routing + config surface only).\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}