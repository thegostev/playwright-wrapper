#!/usr/bin/env node
// playwright-wrapper bin (LAG-478, +LAG-574 skill): routes the five subcommands and validates
// the env-only LLM config at startup — cheap and loud, before anything else.
// Subcommands are stubs in this slice: correct usage text + exit codes.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { loadConfig, USAGE, ConfigError } from "../src/config.mjs";

const SUBCOMMANDS = ["plan", "generate", "heal", "browse", "skill"];

const SUBCOMMAND_USAGE = {
  plan: `playwright-wrapper plan — emit a candidate plan from a live page snapshot

Usage:
  playwright-wrapper plan <spec-file>
  playwright-wrapper plan --inline "<full spec text>"

Reads the task spec (profile + target header, NL goal body), drives the target
page in a real Chromium via the in-process Playwright MCP bridge, snapshots
it, and has the main model emit a keyed-line plan (the LAG-276 grammar). The
raw response is validated unmodified and ids are re-keyed by the harness; on
pass the plan prints to stdout for review; on any grammar violation the
problems print with line numbers and the exit is non-zero — no repair, no
fence-stripping, no retry-until-pass.`,
  generate: `playwright-wrapper generate — compile an approved plan into a stamped spec pair

Usage:
  playwright-wrapper generate < plan.md

Consumes the approved plan verbatim on stdin, validates it against the
generator-output contract, and writes the stamped pair (.spec.ts first line
stamped with the plan sha256 + .plan.md) into the consumer repo.
(Not implemented yet — this slice ships the routing and config surface.)`,
  heal: `playwright-wrapper heal — walk the heal ladder over a self-locating CI run

Usage:
  playwright-wrapper heal <run-folder> [--drift-ok=<sha>]

Consumes a self-locating run (the run folder holds results.json; its name
 carries the report's commit SHA), checks the drift guard, derives the
outcome from the trace, and walks the heal ladder — budget N = 2: a fresh
page snapshot, then the same snapshot plus why attempt 1 failed — asking the
model for a {step_id, locator} proposal at each rung and splicing it into
the spec's single locator slot. When the ladder exhausts, the escalation
router fires (infra > non_retryable > fallback_exhausted > budget_exhausted;
the test profile never produces non_retryable): with OPENAI_API_KEY present
the third tier makes ONE rich-context GPT-5.6 attempt (same interface, no
model fallback), and the one-shot guard forces the terminal with the
original reason. A .heal.md record is written beside results.json for every
non-pass outcome, and the contract_version 2 envelope prints on stdout.
Exit code: healed / nothing_to_heal → 0; no_proposal / compile_failed → 1.
The drift refusal never names its bypass; --drift-ok=<sha> is value-bearing.`,
  browse: `playwright-wrapper browse — planless ReAct loop ending in submit_extraction

Usage:
  playwright-wrapper browse <spec-file>
  playwright-wrapper browse --inline "<full spec text>"

Parses the browsing-profile task spec (profile: browsing + target; an
optional browse: block declares the expected-output JSON Schema path),
runs the planless ReAct loop over the live page with the bridge's core
tools, and ends only on the terminal submit_extraction call. The payload
is classified against the declared schema (verified | asserted) and the
contract-version 2 outcome envelope prints on stdout. Exit code: pass → 0,
not_pass → 1. No plan is ever created for the browsing profile.`,
  skill: `playwright-wrapper skill — install the Claude Code skill

Usage:
  playwright-wrapper skill install [--force] [--print]

Copies the skill shipped inside this package to
~/.claude/skills/playwright-wrapper/SKILL.md, creating the directory, and
stamps the installed copy with the package version so drift between the skill
and the bin it documents is detectable rather than silent. Re-running after a
package upgrade replaces an unedited copy and names both versions; a copy that
has been edited locally is never overwritten without --force. --print writes
the stamped skill to stdout instead, for a target that is not ~/.claude.
Exit code: 0 ok, 1 error, 2 usage.`,
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

  // skill install is model-free too: it copies bytes into ~/.claude/skills.
  // Dispatch BEFORE the config gate — installing the skill on a fresh machine
  // must not require the LLM key to be set yet.
  if (first === "skill") {
    const { skillMain } = await import("./lib/skill.mjs");
    return skillMain(rest);
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

  // plan needs the LLM config AND the bridge (it is not model-free like
  // generate), so it dispatches AFTER the config gate. The stub bodies for
  // the remaining subcommands follow.
  if (first === "plan") {
    const { planMain } = await import("./lib/plan.mjs");
    return planMain(rest);
  }

  // browse needs the LLM config AND the bridge too (it is the planless ReAct
  // loop over the live page).
  if (first === "browse") {
    const { browseMain } = await import("./lib/browse.mjs");
    return browseMain(rest);
  }

  // heal needs the LLM config (it is a ladder rung's model call) but not the
  // bridge until rung 1 snapshots the page — the boundary gates run first.
  if (first === "heal") {
    const { healMain } = await import("./lib/heal.mjs");
    return healMain(rest);
  }

  // No routing stubs remain: every subcommand dispatches above, so this point
  // is unreachable for the known set.
  return 0;
}

// Compare realpaths: ESM realspaths import.meta.url, but argv[1] keeps the
// invoked path — under `npm link` the two differ and the old template-literal
// compare silently skipped the entry (exit 0, no output).
let entryIsMain = false;
try {
  entryIsMain = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  // argv[1] missing (node -e / REPL) — not the main entry.
}
if (entryIsMain) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}