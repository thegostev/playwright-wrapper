// `heal` subcommand (FYR-331): one ladder notch — trace → proposal → patch →
// record, over a SELF-LOCATING run (the results file sits inside the run
// folder; a human hands over nothing else).
//
//   heal <run-folder> [--drift-ok=<sha>]
//
// Order of operations, by the standing rules:
//   1. boundary validation, cheap + loud, BEFORE any model call:
//      drift guard (run-id SHA vs local HEAD, FYR-302) → trace parse →
//      Playwright version known + major-coupled (FYR-249) → outcome routing
//      (FYR-250: only not_pass enters; compile-stage never heals) →
//      generator-shaped spec + stamped plan beside it (FYR-267/268).
//   2. rung 1: fresh snapshot (the bridge warms BEFORE the LLM call) → the
//      FYR-328 client asks the healer for {step_id, locator} data.
//   3. the proposal is validated (lint), then spliced into the spec's single
//      locator slot (text surgery) with a compile-stage safety net; on any
//      compile failure the patch is REVERTED — a broken spec is never left.
//   4. a .heal.md record lands beside results.json for every not_pass
//      outcome; the contract_version 2 envelope prints on stdout.
//
// Honesty rules: the model's words enter the record only as classified
// proposals; refusals are outcomes, not exceptions; nothing is repaired,
// fence-stripped, or retried until it fits.
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkRunDrift } from "../../src/drift-guard.mjs";
import { parseTrace, deriveOutcome, stripAnsi } from "../../src/trace-parse.mjs";
import { parsePlan, lintSpec } from "../../src/plan-parse.mjs";
import { HEALER_PROMPT, buildRungTurn, parseProposal, patchLocator, buildHealRecord, buildEnvelope } from "../../src/heal-core.mjs";
import { complete, LlmError } from "../../src/llm-client.mjs";
import { loadConfig } from "../../src/config.mjs";
import { BrowserBridge } from "../../src/browser-bridge.mjs";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

export class HealError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.name = "HealError";
    this.exitCode = exitCode;
  }
}

/**
 * The page origin to snapshot, resolved from the consumer config contract:
 * the consumer's playwright.config.ts sets baseURL from env, so heal reads
 * the env var NAME out of the config and the value out of the environment.
 * A literal baseURL in the config is honored as-is. Refusal is loud and
 * precedes any model call (the snapshot feeds rung 1).
 */
export function resolveBaseURL(repoRoot, env) {
  const cfgPath = path.join(repoRoot, "playwright.config.ts");
  if (!existsSync(cfgPath)) {
    throw new HealError("cannot reach the page: no playwright.config.ts at the consumer repo root — the consumer-config contract requires one (baseURL from env, testDir on the spec folder)");
  }
  const src = readFileSync(cfgPath, "utf8");
  const m = src.match(/baseURL\s*:\s*(?:process\.env\.([A-Za-z0-9_]+)|['"]([^'"]+)['"])/);
  if (!m) {
    throw new HealError("cannot reach the page: playwright.config.ts declares no baseURL — the consumer-config contract sets baseURL from env");
  }
  if (m[2] !== undefined) return m[2];
  const name = m[1];
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HealError(`cannot reach the page: playwright.config.ts reads baseURL from process.env.${name}, which is not set in this shell — set it to the site the run was made against`);
  }
  return value;
}

/**
 * The heal body, injectable for tests: everything the bin path needs.
 * @param {object} opts
 * @param {string} opts.runFolder - path to the self-locating run folder
 * @param {string} [opts.driftOverride] - value-bearing --drift-ok=<sha>
 * @param {object} opts.config - pre-loaded LLM config
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.cwd] - the consumer repo (drift guard resolves HEAD here)
 * @param {string} [opts.rawModelResponse] - canned response (tests): skip the
 *        LLM call but keep everything else
 * @param {string} [opts.cannedSnapshot] - snapshot for the canned path
 * @param {object} [opts.bridge] - injected bridge (tests); default = real one
 */
/** The no-proposal terminal: record every not_pass outcome, exit non-zero. */
function finishNoProposal({
  runFolder,
  outcome,
  runId,
  drift,
  specPath,
  planPath,
  planStep,
  rungs,
  attempts,
  targetUrl,
  snapshotText,
  config,
}) {
  const recordPath = path.join(runFolder, `${planFileSlug(planPath)}.heal.md`);
  const recordText = buildHealRecord({
    runId, reportSha: drift.runSha, headSha: drift.headSha, specPath, planPath,
    outcome: "no_proposal", outcomeClass: outcome.outcomeClass, status: outcome.status,
    errorStage: outcome.errorStage, failingStep: { id: outcome.failingStepId, action: planStep.action, errorMessage: outcome.errorMessage },
    failedLocator: outcome.failedLocator, attemptedIds: outcome.attemptedIds,
    rungs, attempts, targetUrl, snapshotText,
  });
  writeFileSync(recordPath, recordText);
  return {
    envelope: buildEnvelope({
      outcome: "no_proposal", outcomeClass: outcome.outcomeClass, status: outcome.status, errorStage: outcome.errorStage,
      failingStepId: outcome.failingStepId, attempts, thirdTierEnabled: config.thirdTierKeyPresent,
      recordPath, patch: null, nFailingTests: outcome.nFailingTests, verified: false,
    }),
  };
}

/** The plan file's slug (its header `file:` value is derivable from the name). */
function planFileSlug(planPath) {
  return path.basename(planPath).replace(/\.plan\.md$/, "");
}

export async function runHeal({
  runFolder,
  driftOverride,
  config,
  env = process.env,
  cwd = process.cwd(),
  rawModelResponse = null,
  cannedSnapshot = null,
  bridge = null,
} = {}) {
  // ---- 1. Boundary validation — before any model call. --------------------
  if (!runFolder || !existsSync(runFolder) || !statSync(runFolder).isDirectory()) {
    throw new HealError(`run folder not found: ${runFolder ?? "<none given>"} — pass the folder holding results.json`, { exitCode: 2 });
  }
  const resultsPath = path.join(runFolder, "results.json");
  if (!existsSync(resultsPath)) {
    throw new HealError(`self-locating run: results.json is not inside ${runFolder} — heal consumes the folder the results file sits in`, { exitCode: 2 });
  }
  const runId = path.basename(path.resolve(runFolder));

  const drift = checkRunDrift({ run: runId, cwd, override: driftOverride });
  if (!drift.ok) {
    throw new HealError(drift.message, { exitCode: 1 });
  }

  const parsed = parseTrace(readFileSync(resultsPath, "utf8"));
  if (!parsed.ok) {
    throw new HealError(`trace refused:\n${parsed.problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  const outcome = deriveOutcome(parsed.report);

  // Playwright version coupling (FYR-249): the report's version must be known
  // and in the same major as the local install — a cross-major patch is
  // healing against a different runner.
  const reportVersion = outcome.version;
  const localPkgPath = path.join(ROOT, "node_modules", "@playwright", "test", "package.json");
  let localVersion = null;
  try {
    localVersion = JSON.parse(readFileSync(localPkgPath, "utf8")).version;
  } catch {
    /* the wrapper's own install is broken — caught below */
  }
  const reportSem = reportVersion?.match(/^(\d+)\./);
  const localSem = localVersion?.match(/^(\d+)\./);
  if (!localSem) {
    throw new HealError("cannot determine the local @playwright/test version — the heal patcher must know which runner it patches for");
  }
  if (reportSem[1] !== localSem[1]) {
    throw new HealError(
      `version mismatch: the report was produced by Playwright ${reportVersion} but this checkout runs ${localVersion} — refusing to patch across majors (FYR-249 pins the runner)`,
    );
  }

  if (outcome.outcomeClass === "pass") {
    return { envelope: buildEnvelope({ outcome: "nothing_to_heal", outcomeClass: "pass", status: outcome.status, errorStage: null, failingStepId: null, attempts: { n_primary: 0, n_fallback: 0 }, thirdTierEnabled: config.thirdTierKeyPresent, recordPath: null, patch: null, nFailingTests: 0 }), writeNothing: true };
  }
  if (outcome.outcomeClass === "no_verdict") {
    throw new HealError(
      `the run carries no verdict (status: ${outcome.status ?? "unknown"}) — no_verdict never enters the heal loop (FYR-250); inspect the run folder by hand`,
    );
  }
  if (outcome.errorStage === "compile") {
    // A spec that never ran (import error, module-top throw) is not healable
    // by a locator proposal — the heal ladder re-addresses steps, it cannot
    // fix source. Loud refusal with a record of why nothing was tried.
    throw new HealError("the trace shows a compile-stage failure (the spec never ran) — the heal ladder addresses run/assert failures only", {
      exitCode: 1,
    });
  }
  if (!outcome.failingStepId) {
    throw new HealError("the trace names no failing [sN] step — the failure address could not be derived from the JSON report (no source-location fallback exists)");
  }

  // Generator-shaped spec + stamped plan beside it.
  const specPath = outcome.specPath;
  if (!specPath || !existsSync(specPath)) {
    throw new HealError(`the failing spec is not beside this checkout: ${specPath ?? "<unresolved from the report>"}`);
  }
  const specSource = readFileSync(specPath, "utf8");
  const lint = lintSpec(specSource);
  if (!lint.ok) {
    throw new HealError(`the failing spec does not satisfy the generator-output contract — heal patches generated specs only:\n${lint.problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  const planPath = specPath.replace(/\.spec\.ts$/, ".plan.md");
  if (!existsSync(planPath)) {
    throw new HealError(`no stamped plan beside the spec (${planPath}) — heal consumes generated pairs only`);
  }
  const plan = parsePlan(readFileSync(planPath, "utf8"));
  const planStep = plan.steps.find((s) => s.id === outcome.failingStepId);
  if (!planStep) {
    throw new HealError(`step ${outcome.failingStepId} is in the trace but not in the approved plan — the pair has drifted; regenerate instead`);
  }
  const knownIds = lint.ids;

  // The page to snapshot: baseURL from the consumer config (the contract sets
  // it from env) + the plan's navigation path.
  const baseURL = resolveBaseURL(cwd, env);
  const gotoStep = plan.steps.find((s) => s.action.startsWith("go to") && /^literal '/.test(s.value ?? ""));
  const gotoPath = gotoStep ? gotoStep.value.match(/^literal '([^']*)'$/)[1] : "/";
  const targetUrl = new URL(gotoPath, baseURL).toString();

  // ---- 2. Rung 1: fresh snapshot, then the healer call. --------------------
  const own = bridge === null;
  const b = bridge ?? new BrowserBridge();
  let snapshotText;
  try {
    if (own) await b.warmContext();
    await b.navigate(targetUrl);
    snapshotText = cannedSnapshot ?? (await b.snapshot());
  } catch (err) {
    if (own) await b.close().catch(() => {});
    throw new HealError(`browser bridge failed: ${err.message}`);
  } finally {
    if (own) await b.close().catch(() => {});
  }

  const rungs = [];
  const attempts = { n_primary: 1, n_fallback: 0 };
  let proposalResult;
  if (rawModelResponse !== null) {
    proposalResult = { content: rawModelResponse, model: "canned", fallbackFrom: null };
  } else {
    let completion;
    try {
      completion = await complete({
        system: HEALER_PROMPT,
        user: buildRungTurn(
          {
            id: outcome.failingStepId,
            action: planStep.action,
            locator: planStep.locator,
            stage: outcome.errorStage,
            errorMessage: outcome.errorMessage,
          },
          snapshotText,
        ),
        maxTokens: 2048,
        config,
      });
    } catch (err) {
      // Both tiers failed: the rung produced nothing — recorded, not retried.
      attempts.n_fallback = 1;
      rungs.push({ rung: 1, result: { class: "stuck", reason: `llm_failed: ${err instanceof LlmError ? err.message : err.message}` } });
      return finishNoProposal({ runFolder, outcome, runId, drift, specPath, planPath, planStep, rungs, attempts, targetUrl, snapshotText, config });
    }
    proposalResult = completion;
    if (completion.fallbackFrom) attempts.n_fallback = 1;
  }

  rungs.push({ rung: 1, result: { proposal: null, ...proposalResult, raw: proposalResult.content } });
  const verdict = parseProposal(proposalResult.content, { knownIds: knownIds });
  rungs[rungs.length - 1].result = verdict.ok
    ? { proposal: { stepId: verdict.proposal.stepId, locator: verdict.proposal.locator } }
    : { refusal: verdict.refusal };

  if (!verdict.ok) {
    return finishNoProposal({ runFolder, outcome, runId, drift, specPath, planPath, planStep, rungs, attempts, targetUrl, snapshotText, config });
  }

  // The model may address a different step than the one that failed — that is
  // a restructure of the failure address, refused as an outcome.
  if (verdict.proposal.stepId !== outcome.failingStepId) {
    rungs[rungs.length - 1].result = {
      refusal: { class: "banned", reason: `proposal targets ${verdict.proposal.stepId} but the trace failed at ${outcome.failingStepId} — a heal re-addresses the failing step` },
    };
    return finishNoProposal({ runFolder, outcome, runId, drift, specPath, planPath, planStep, rungs, attempts, targetUrl, snapshotText, config });
  }

  // ---- 3. Patch: text surgery + compile-stage safety net. ------------------
  const patchRes = patchLocator(specSource, outcome.failingStepId, verdict.proposal.locator);
  if (!patchRes.ok) {
    rungs[rungs.length - 1].result = { class: "stuck", reason: patchRes.reason };
    return finishNoProposal({ runFolder, outcome, runId, drift, specPath, planPath, planStep, rungs, attempts, targetUrl, snapshotText, config });
  }

  const recordPath = path.join(runFolder, `${plan.header.file}.heal.md`);
  const patchLint = lintSpec(patchRes.source);
  let patched = false;
  let compileError = null;
  if (!patchLint.ok) {
    compileError = patchLint.problems.join("; ");
  } else {
    writeFileSync(specPath, patchRes.source);
    const check = spawnSync(process.execPath, ["--experimental-strip-types", "--check", specPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (check.status === 0) {
      patched = true;
    } else {
      compileError = stripAnsi(`${check.stderr ?? ""}${check.stdout ?? ""}`).trim();
      writeFileSync(specPath, specSource); // safety net: never leave a broken spec
    }
  }

  rungs[rungs.length - 1].result = patched
    ? { proposal: { stepId: verdict.proposal.stepId, locator: verdict.proposal.locator }, changed: patchRes.changed }
    : { proposal: { stepId: verdict.proposal.stepId, locator: verdict.proposal.locator }, changed: patchRes.changed, compileError };

  if (!patched) {
    const recordText = buildHealRecord({
      runId, reportSha: drift.runSha, headSha: drift.headSha, specPath, planPath,
      outcome: "compile_failed", outcomeClass: outcome.outcomeClass, status: outcome.status,
      errorStage: outcome.errorStage, failingStep: { id: outcome.failingStepId, action: planStep.action, errorMessage: outcome.errorMessage },
      failedLocator: outcome.failedLocator, attemptedIds: outcome.attemptedIds,
      rungs, attempts, targetUrl, snapshotText,
    });
    writeFileSync(recordPath, recordText);
    return {
      envelope: buildEnvelope({
        outcome: "compile_failed", outcomeClass: outcome.outcomeClass, status: outcome.status, errorStage: outcome.errorStage,
        failingStepId: outcome.failingStepId, attempts, thirdTierEnabled: config.thirdTierKeyPresent,
        recordPath, patch: { stepId: verdict.proposal.stepId, oldLocator: patchRes.oldLocator, newLocator: verdict.proposal.locator, changed: patchRes.changed },
        nFailingTests: outcome.nFailingTests, verified: false,
      }),
    };
  }

  // ---- 4. Record + envelope. ----------------------------------------------
  const recordText = buildHealRecord({
    runId, reportSha: drift.runSha, headSha: drift.headSha, specPath, planPath,
    outcome: "healed", outcomeClass: outcome.outcomeClass, status: outcome.status,
    errorStage: outcome.errorStage, failingStep: { id: outcome.failingStepId, action: planStep.action, errorMessage: outcome.errorMessage },
    failedLocator: outcome.failedLocator, attemptedIds: outcome.attemptedIds,
    rungs, attempts, targetUrl, snapshotText,
  });
  writeFileSync(recordPath, recordText);

  return {
    envelope: buildEnvelope({
      outcome: "healed", outcomeClass: outcome.outcomeClass, status: outcome.status, errorStage: outcome.errorStage,
      failingStepId: outcome.failingStepId, attempts, thirdTierEnabled: config.thirdTierKeyPresent,
      recordPath,
      patch: { stepId: verdict.proposal.stepId, oldLocator: patchRes.oldLocator, newLocator: verdict.proposal.locator, changed: patchRes.changed },
      nFailingTests: outcome.nFailingTests,
      verified: false,
    }),
    snapshot: snapshotText,
  };
}

export async function healMain(argv) {
  // Args: <run-folder> [--drift-ok=<sha>]
  const driftArg = argv.find((a) => a.startsWith("--drift-ok="));
  const positional = argv.filter((a) => !a.startsWith("--"));
  if (positional.length !== 1) {
    process.stderr.write(
      "playwright-wrapper heal: missing run folder\n\n" +
        "Usage: playwright-wrapper heal <run-folder> [--drift-ok=<sha>]\n\n" +
        "<run-folder> holds results.json (the self-locating run); its name carries\n" +
        "the report's commit SHA (YYYY-MM-DDTHHmmssZ-<sha7>).\n",
    );
    return 2;
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
    const res = await runHeal({
      runFolder: positional[0],
      driftOverride: driftArg ? driftArg.slice("--drift-ok=".length) : undefined,
      config,
      env: process.env,
    });
    process.stdout.write(JSON.stringify(res.envelope, null, 2) + "\n");
    // Exit contract: healed / nothing_to_heal → 0; no_proposal / compile_failed → 1.
    return res.envelope.outcome === "healed" || res.envelope.outcome === "nothing_to_heal" ? 0 : 1;
  } catch (err) {
    if (err instanceof HealError) {
      process.stderr.write(`playwright-wrapper heal: ${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }
}