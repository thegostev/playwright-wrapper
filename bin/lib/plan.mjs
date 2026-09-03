// `plan` subcommand (FYR-329): task spec → live snapshot → LLM emission →
// grammar-validated, id-re-keyed plan on stdout.
//
//   - task spec parsed/validated first (boundary validation before any
//     model call): profile/target header + NL goal (src/task-spec.mjs)
//   - the in-process bridge warms the context, navigates the target, and
//     snapshots the page (the observation format is the ref-based YAML)
//   - the FYR-328 client calls the main model with the FYR-267 grammar as
//     the system turn and snapshot + goal as the user turn
//   - the RAW response is validated unmodified by the plan module; step ids
//     are re-keyed by the harness (s1..sN; next_id = high-water + 1) — the
//     model never authors ids
//   - pass → plan prints to stdout, exit 0. Any violation: the problems
//     print with line numbers on stderr, exit 1. NO repair, no
//     fence-stripping, no retry-until-pass (honesty over convenience).

import { parseTaskSpec, TaskSpecRefusal } from "../../src/task-spec.mjs";
import { GRAMMAR, buildTaskTurn, emitVerdict } from "../../src/plan-emit.mjs";
import { complete, LlmError } from "../../src/llm-client.mjs";
import { loadConfig } from "../../src/config.mjs";
import { BrowserBridge } from "../../src/browser-bridge.mjs";

export class PlanError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.name = "PlanError";
    this.exitCode = exitCode;
  }
}

/**
 * The plan body, injectable for tests: everything the bin path needs.
 * @param {object} opts
 * @param {string} opts.specText - the task-spec bytes
 * @param {object} opts.config - pre-loaded LLM config
 * @param {string} opts.rawModelResponse - canned response (tests); when set,
 *        no LLM call and no browser are used — the response is validated as-is
 * @param {string} opts.cannedSnapshot - snapshot text for the canned path
 * @param {object} [opts.bridge] - injected bridge (tests); default = real one
 */
export async function runPlan({ specText, config, rawModelResponse = null, cannedSnapshot = null, bridge = null } = {}) {
  // 1. Boundary validation before any model call: the task spec.
  let spec;
  try {
    spec = parseChecked(specText);
  } catch (err) {
    if (err instanceof TaskSpecRefusal) {
      throw new PlanError(err.message, { exitCode: 2 });
    }
    throw err;
  }
  if (spec.header.profile !== "test") {
    throw new PlanError(
      `plan serves the test profile only (this spec declares profile: ${spec.header.profile}; browsing is planless by design — use the browse subcommand)`,
    );
  }

  // Canned path (tests): validate the raw response against the grammar
  // without touching the browser or the LLM.
  if (rawModelResponse !== null) {
    const verdict = emitVerdict(rawModelResponse);
    if (!verdict.ok) {
      throw new PlanError(
        `plan rejected — the raw model response failed the generator-output contract:\n${verdict.problems.map((p) => `  - ${p}`).join("\n")}`,
        { exitCode: 1 },
      );
    }
    return { planText: verdict.planText, envNames: verdict.envNames, snapshot: cannedSnapshot ?? "", goal: spec.goal };
  }

  // 2. Warm the browser, navigate the target, capture the snapshot. The cold
  //    start happens HERE, before the LLM call (never inside a loop).
  const own = bridge === null;
  const b = bridge ?? new BrowserBridge();
  let snapshotText;
  try {
    if (own) await b.warmContext();
    await b.navigate(spec.header.target);
    // The navigate response may spill its snapshot to a file; take an
    // explicit snapshot for the inline text.
    snapshotText = await b.snapshot();
  } catch (err) {
    if (own) await b.close().catch(() => {});
    throw new PlanError(`browser bridge failed: ${err.message}`);
  } finally {
    if (own) await b.close().catch(() => {});
  }

  // 3. The model call: grammar system turn, snapshot + goal user turn.
  let completion;
  try {
    completion = await complete({
      system: GRAMMAR,
      user: buildTaskTurn(snapshotText, spec.goal, spec.header.target),
      maxTokens: 4096,
      config,
    });
  } catch (err) {
    if (own) await b.close().catch(() => {});
    if (err instanceof LlmError) {
      throw new PlanError(`LLM call failed: ${err.message}`);
    }
    throw new PlanError(`LLM call failed: ${err.message}`);
  }

  // 4. Validate the RAW response unmodified (re-keyed ids, then the full
  //    grammar). On any violation: problems with line numbers, non-zero —
  //    zero repair.
  const verdict = emitVerdict(completion.content);
  if (!verdict.ok) {
    throw new PlanError(
      `plan rejected — the raw model response failed the generator-output contract (model: ${completion.model}):\n` +
        verdict.problems.map((p) => `  - ${p}`).join("\n"),
      { exitCode: 1 },
    );
  }
  return { planText: verdict.planText, envNames: verdict.envNames, snapshot: snapshotText, goal: spec.goal };
}

function parseChecked(specText) {
  return parseTaskSpec(specText);
}

export async function planMain(argv) {
  // The spec file argument (or inline text via --inline).
  const inlineIdx = argv.indexOf("--inline");
  let specText = null;
  if (inlineIdx !== -1) {
    specText = argv[inlineIdx + 1] ?? "";
  } else {
    const file = argv[0];
    if (!file || file.startsWith("-")) {
      process.stderr.write(
        "playwright-wrapper plan: missing spec argument\n\n" +
          "Usage: playwright-wrapper plan <spec-file>\n" +
          "       playwright-wrapper plan --inline \"<full spec text>\"\n",
      );
      return 2;
    }
    const { readFileSync } = await import("node:fs");
    try {
      specText = readFileSync(file, "utf8");
    } catch (err) {
      process.stderr.write(`playwright-wrapper plan: cannot read spec file: ${err.message}\n`);
      return 2;
    }
  }

  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err?.name === "ConfigError") {
      process.stderr.write(`playwright-wrapper: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  try {
    const res = await runPlan({ specText, config });
    process.stdout.write(res.planText + "\n");
    return 0;
  } catch (err) {
    if (err instanceof PlanError) {
      process.stderr.write(`playwright-wrapper plan: ${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }
}