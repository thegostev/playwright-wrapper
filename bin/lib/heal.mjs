// `heal` subcommand (FYR-331 rung 1 + FYR-332 full ladder): trace → ladder →
// escalation → record, over a SELF-LOCATING run (the results file sits inside
// the run folder; a human hands over nothing else).
//
//   heal <run-folder> [--drift-ok=<sha>]
//
// Order of operations, by the standing rules:
//   1. boundary validation, cheap + loud, BEFORE any model call:
//      drift guard (run-id SHA vs local HEAD, FYR-302) → trace parse →
//      Playwright version known + major-coupled (FYR-249) → outcome routing
//      (FYR-250: only not_pass enters; compile-stage never heals) →
//      generator-shaped spec + stamped plan beside it (FYR-267/268).
//   2. the heal ladder, budget N = 2 (FYR-250: an attempt is allowed only if
//      its input differs from the previous attempt):
//        rung 1: fresh snapshot (the bridge warms BEFORE the LLM call) →
//                {step_id, locator} proposal from the main/fallback pair.
//        rung 2: the same snapshot + WHY attempt 1 failed (data in hand).
//   3. a validated proposal is spliced into the spec's single locator slot
//      (text surgery) with a compile-stage safety net; on any compile failure
//      the patch is REVERTED — a broken spec is never left.
//   4. ladder exhausted → the escalation router (FYR-257) fills the
//      disposition for the loop-derived reason (FYR-250 precedence, test
//      profile: never non_retryable). On budget/fallback exhaustion with the
//      key present the third tier fires ONCE (FYR-294): rich-context, same
//      {step_id, locator} interface, no model fallback. The one-shot guard is
//      loop-side: third-tier exhaustion forces the terminal with the ORIGINAL
//      reason — no router re-consult, no new reason.
//   5. exactly ONE escalation event fires, at the true terminal; a .heal.md
//      record lands beside results.json for every non-pass outcome; the
//      contract_version 2 envelope prints on stdout with the outcome_history
//      invariant asserted before it leaves the loop.
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
import {
  HEALER_PROMPT, buildRungTurn, buildRungTwoTurn, buildThirdTierTurn,
  parseProposal, patchLocator, buildHealRecord, buildEnvelope,
  routeEscalation, deriveEscalationReason, historyEntry, expectedHistoryLength,
} from "../../src/heal-core.mjs";
import { complete, completeThirdTier, LlmError } from "../../src/llm-client.mjs";
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
 * One ladder rung's LLM call, canned when a raw response is injected (tests).
 * rawResponse: undefined = the real client path; null = canned call failure;
 * string = canned content (the primary "answered").
 * Returns {kind: 'content', content, viaFallback} | {kind: 'failed', message}.
 */
async function callRung({ system, user, config, rawResponse }) {
  if (rawResponse === undefined) {
    try {
      const completion = await complete({ system, user, maxTokens: 2048, config });
      return {
        kind: "content",
        content: completion.content,
        viaFallback: Boolean(completion.fallbackFrom),
      };
    } catch (err) {
      // Both tiers failed: the rung produced nothing — recorded, not retried.
      return { kind: "failed", message: `llm_failed: ${err?.message ?? String(err)}`, viaFallback: true };
    }
  }
  if (rawResponse === null) {
    // Canned failure fixture: the call dies and the fallback was engaged.
    return { kind: "failed", message: "llm_failed: canned llm failure fixture", viaFallback: true };
  }
  return { kind: "content", content: rawResponse, viaFallback: false };
}

/**
 * The third tier's call (FYR-294), canned or real. One attempt, no model
 * fallback — bounded transport retries live inside the client.
 */
async function callTier({ system, user, config, rawResponse }) {
  if (rawResponse !== undefined && rawResponse !== null) {
    return { kind: "content", content: rawResponse };
  }
  if (rawResponse === null) {
    return { kind: "failed", message: "canned third-tier failure fixture" };
  }
  try {
    const completion = await completeThirdTier({ system, user, maxTokens: 512, config });
    return { kind: "content", content: completion.content, model: completion.model };
  } catch (err) {
    return { kind: "failed", message: `llm_failed: ${err?.message ?? String(err)}` };
  }
}

/**
 * Parse a rung's raw response into a proposal, enforcing the same-address
 * rule: a proposal targeting any other step re-structures the failure
 * address — refused as an outcome (banned).
 */
function judgeProposal(content, knownIds, failingStepId) {
  const verdict = parseProposal(content, { knownIds });
  if (!verdict.ok) return { ok: false, refusal: verdict.refusal };
  if (verdict.proposal.stepId !== failingStepId) {
    return {
      ok: false,
      refusal: {
        class: "banned",
        reason: `proposal targets ${verdict.proposal.stepId} but the trace failed at ${failingStepId} — a heal re-addresses the failing step`,
      },
    };
  }
  return { ok: true, proposal: verdict.proposal };
}

/**
 * Patch + compile safety net. A patch that fails lint or compile is REVERTED
 * (a broken spec is never left); the refusal text is an outcome.
 */
function applyPatch({ specSource, specPath, stepId, locator }) {
  const patchRes = patchLocator(specSource, stepId, locator);
  if (!patchRes.ok) return { ok: false, kind: "patch_refused", reason: patchRes.reason, patchRes: null };
  const patchLint = lintSpec(patchRes.source);
  if (!patchLint.ok) {
    return { ok: false, kind: "patch_refused", reason: `patched spec failed the spec lint: ${patchLint.problems.join("; ")}`, patchRes };
  }
  writeFileSync(specPath, patchRes.source);
  const check = spawnSync(process.execPath, ["--experimental-strip-types", "--check", specPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (check.status === 0) {
    return { ok: true, kind: "healed", patchRes };
  }
  const compileError = stripAnsi(`${check.stderr ?? ""}${check.stdout ?? ""}`).trim();
  writeFileSync(specPath, specSource); // safety net: never leave a broken spec
  return {
    ok: false,
    kind: "compile_failed",
    reason: `compile_failed: ${compileError.split("\n")[0].slice(0, 200)}`,
    patchRes,
    compileError,
  };
}

export async function runHeal({
  runFolder,
  driftOverride,
  config,
  env = process.env,
  cwd = process.cwd(),
  rawModelResponse = undefined,
  rawModelResponse2 = undefined,
  rawThirdTierResponse = undefined,
  cannedSnapshot = null,
  bridge = null,
  interactive = process.stdout?.isTTY === true,
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
    return {
      envelope: buildEnvelope({
        outcome: "nothing_to_heal", outcomeClass: "pass", status: outcome.status, errorStage: null,
        failingStepId: null, attempts: { n_primary: 0, n_fallback: 0, third_tier: 0 },
        thirdTierEnabled: config.thirdTierKeyPresent, escalation: null, outcomeHistory: [],
        recordPath: null, patch: null, nFailingTests: 0, verified: false,
      }),
      writeNothing: true,
    };
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

  const recordPath = path.join(runFolder, `${plan.header.file}.heal.md`);
  const failingStep = { id: outcome.failingStepId, action: planStep.action, errorMessage: outcome.errorMessage };

  // ---- 2. The fresh snapshot — the ladder's page state. --------------------
  const own = bridge === null;
  const b = bridge ?? new BrowserBridge();
  let snapshotText;
  try {
    if (own) await b.warmContext();
    await b.navigate(targetUrl);
    snapshotText = cannedSnapshot ?? (await b.snapshot());
  } catch (err) {
    if (own) await b.close().catch(() => {});
    // Environment failure: reason `infra` (FYR-250 — built from loop-state,
    // here the tool that failed is the browser itself). Disposition is
    // Terminal(prompt) — the third tier is a capability valve, not an
    // availability failover (FYR-257). No rung ran: attempts.total == 0 and
    // outcome_history is empty (the FYR-250 presence rule).
    return finishTerminal({
      runOutcome: "no_proposal",
      rungs: [],
      attempts: { n_primary: 0, n_fallback: 0, third_tier: 0 },
      thirdTier: null, escalationReason: "infra", history: [], patch: null,
    });
  } finally {
    if (own) await b.close().catch(() => {});
  }

  // ---- 3. The ladder, budget N = 2 (FYR-250). ------------------------------
  const rungs = [];
  const attempts = { n_primary: 0, n_fallback: 0, third_tier: 0 };
  const history = [];
  const failedProposals = []; // what the pair proposed and how it was rejected
  let whyFailed = null;       // rung 2's added context
  let lastRunOutcome = "no_proposal";
  let lastPatch = null;
  let healed = false;
  const pushHistory = (actor, histOutcome) => history.push(historyEntry(history.length + 1, actor, histOutcome));

  for (let rung = 1; rung <= 2 && !healed; rung++) {
    const step = {
      id: outcome.failingStepId,
      action: planStep.action,
      locator: planStep.locator,
      stage: outcome.errorStage,
      errorMessage: outcome.errorMessage,
    };
    const user =
      rung === 1
        ? buildRungTurn(step, snapshotText)
        : buildRungTwoTurn(step, snapshotText, whyFailed);

    const raw = rung === 1 ? rawModelResponse : (rawModelResponse2 === undefined ? rawModelResponse : rawModelResponse2);
    const call = await callRung({ system: HEALER_PROMPT, user, config, rawResponse: raw });
    attempts.n_primary += 1;

    if (call.kind === "failed") {
      // Both tiers died on this rung: the primary errored and the fallback
      // was engaged (and errored). No content — rung 2's input will differ.
      attempts.n_fallback += 1;
      pushHistory("primary", "errored");
      pushHistory("fallback", "errored");
      rungs.push({ rung, result: { class: "stuck", reason: call.message } });
      whyFailed = `attempt ${rung}'s model call failed (${call.message})`;
      continue;
    }

    const actor = call.viaFallback ? "fallback" : "primary";
    if (call.viaFallback) attempts.n_fallback += 1;

    const judged = judgeProposal(call.content, knownIds, outcome.failingStepId);
    let histOutcome;
    if (!judged.ok) {
      histOutcome = "no_proposal";
      rungs.push({ rung, result: { refusal: judged.refusal } });
      whyFailed = `attempt ${rung} answered but the proposal was refused (${judged.refusal.class}: ${judged.refusal.reason})`;
    } else {
      const proposal = judged.proposal;
      const patch = applyPatch({ specSource, specPath, stepId: proposal.stepId, locator: proposal.locator });
      histOutcome = patch.kind; // healed | patch_refused | compile_failed
      if (patch.ok) {
        rungs.push({ rung, result: { proposal: { stepId: proposal.stepId, locator: proposal.locator }, changed: patch.patchRes.changed } });
        lastPatch = {
          stepId: proposal.stepId, oldLocator: patch.patchRes.oldLocator,
          newLocator: proposal.locator, changed: patch.patchRes.changed,
        };
        lastRunOutcome = "healed";
        healed = true;
      } else {
        rungs.push({
          rung,
          result: {
            proposal: { stepId: proposal.stepId, locator: proposal.locator },
            reason: patch.reason,
            compileError: patch.compileError ?? null,
          },
        });
        lastPatch = {
          stepId: proposal.stepId, oldLocator: patch.patchRes?.oldLocator ?? null,
          newLocator: proposal.locator, changed: patch.patchRes?.changed ?? false,
        };
        lastRunOutcome = patch.kind;
        whyFailed = patch.kind === "compile_failed"
          ? `attempt ${rung}'s proposal ${proposal.locator} was spliced in but the patched spec failed to compile (${patch.reason.replace("compile_failed: ", "")})`
          : `attempt ${rung} proposed ${proposal.locator} but the patcher refused (${patch.reason})`;
        failedProposals.push({ actor, stepId: proposal.stepId, locator: proposal.locator, verdict: patch.reason });
      }
    }
    pushHistory(actor, histOutcome);
  }

  if (healed) {
    // Success — no escalation event exists on this path (FYR-294); the
    // ladder's story is audited in the record.
    return finishTerminal({
      runOutcome: "healed", rungs, attempts, thirdTier: null,
      escalationReason: null, history, patch: lastPatch,
    });
  }

  // ---- 4. Ladder exhausted → the escalation router (FYR-250/257). ----------
  const reason = deriveEscalationReason({ fallbackEngaged: attempts.n_fallback > 0 });
  const route = routeEscalation({ reason, thirdTierEnabled: config.thirdTierKeyPresent });
  if (!route.retryThirdTier && route.disposition === null) {
    // Loud-fatal (Q3): a contract gap fails the run — never a silent default.
    throw new HealError(
      `escalation reason "${reason}" has no disposition in the test profile (FYR-257: non_retryable is owned by browsing) — halting loudly instead of guessing`,
    );
  }

  if (route.retryThirdTier) {
    // FYR-294: ONE rich-context GPT-5.6 attempt, same healer interface, no
    // model fallback. The one-shot guard is loop-side: whatever happens, the
    // loop forces the terminal with the ORIGINAL reason afterwards — no
    // router re-consult, no new reason.
    if (!config.thirdTierModel) {
      throw new HealError(
        "third tier is enabled (OPENAI_API_KEY present) but the config carries no third-tier model id — the actor must be resolvable before the shot is spent",
      );
    }
    attempts.third_tier = 1;
    const tierUser = buildThirdTierTurn(
      { id: outcome.failingStepId, action: planStep.action, locator: planStep.locator, stage: outcome.errorStage, errorMessage: outcome.errorMessage },
      snapshotText,
      whyFailed ?? "(the ladder produced no verdicts)",
      failedProposals,
    );
    const tierCall = await callTier({ system: HEALER_PROMPT, user: tierUser, config, rawResponse: rawThirdTierResponse });
    const tierActor = tierCall.model || config.thirdTierModel;

    if (tierCall.kind === "failed") {
      // Errored: invoked, no usable run — the history deficit case.
      return finishTerminal({
        runOutcome: lastRunOutcome, rungs, attempts,
        thirdTier: { actor: tierActor, outcome: "errored", error: tierCall.message },
        escalationReason: reason, history, patch: null,
      });
    }

    const judged = judgeProposal(tierCall.content, knownIds, outcome.failingStepId);
    if (!judged.ok) {
      // 294's outcome vocabulary: a STUCK refusal means the tier returned
      // nothing usable → `no_proposal` (invoked, no usable run — the history
      // deficit case). A BANNED refusal means it answered out-of-contract →
      // the tier's `failed` (a real attempt, a history entry).
      if (judged.refusal.class === "stuck") {
        return finishTerminal({
          runOutcome: "no_proposal", rungs, attempts,
          thirdTier: { actor: tierActor, outcome: "no_proposal", refusal: judged.refusal },
          escalationReason: reason, history, patch: null,
        });
      }
      pushHistory("third_tier", "failed");
      return finishTerminal({
        runOutcome: "no_proposal", rungs, attempts,
        thirdTier: { actor: tierActor, outcome: "failed", refusal: judged.refusal },
        escalationReason: reason, history, patch: null,
      });
    }

    const proposal = judged.proposal;
    const patch = applyPatch({ specSource, specPath, stepId: proposal.stepId, locator: proposal.locator });
    if (!patch.ok) {
      // Answered, but the remediation did not take → the tier's `failed`.
      pushHistory("third_tier", "failed");
      return finishTerminal({
        runOutcome: patch.kind, rungs, attempts,
        thirdTier: {
          actor: tierActor, outcome: "failed",
          proposal: { stepId: proposal.stepId, locator: proposal.locator },
          refusal: patch.kind === "compile_failed" ? undefined : { class: "stuck", reason: patch.reason },
          compileError: patch.compileError,
          patch: {
            stepId: proposal.stepId, oldLocator: patch.patchRes?.oldLocator ?? null,
            newLocator: proposal.locator, changed: patch.patchRes?.changed ?? false,
          },
        },
        escalationReason: reason, history, patch: null,
      });
    }

    // The tier healed it — success produces NO escalation event (FYR-294);
    // it is audited in the record.
    pushHistory("third_tier", "healed");
    return finishTerminal({
      runOutcome: "healed", rungs, attempts,
      thirdTier: {
        actor: tierActor, outcome: "healed",
        proposal: { stepId: proposal.stepId, locator: proposal.locator },
        patch: {
          stepId: proposal.stepId, oldLocator: patch.patchRes.oldLocator,
          newLocator: proposal.locator, changed: patch.patchRes.changed,
        },
      },
      escalationReason: null, history,
      patch: {
        stepId: proposal.stepId, oldLocator: patch.patchRes.oldLocator,
        newLocator: proposal.locator, changed: patch.patchRes.changed,
      },
    });
  }

  // ---- 5. No-key terminal (or any terminating disposition): prompt/defer. --
  return finishTerminal({
    runOutcome: lastRunOutcome, rungs, attempts, thirdTier: null,
    escalationReason: reason, history, patch: null,
  });

  /** The one terminal builder: record + envelope, exactly one escalation. */
  function finishTerminal({ runOutcome, rungs, attempts, thirdTier, escalationReason, history, patch }) {
    const disposition = interactive ? "prompt" : "defer";
    const escalation = escalationReason
      ? {
          event: "escalation",
          reason: escalationReason,
          profile: "test",
          disposition,
          ts: new Date().toISOString(),
        }
      : null;
    const recordText = buildHealRecord({
      runId, reportSha: drift.runSha, headSha: drift.headSha, specPath, planPath,
      outcome: runOutcome, outcomeClass: outcome.outcomeClass, status: outcome.status,
      errorStage: outcome.errorStage, failingStep,
      failedLocator: outcome.failedLocator, attemptedIds: outcome.attemptedIds,
      rungs, attempts, targetUrl, snapshotText, thirdTier, escalation,
    });
    writeFileSync(recordPath, recordText);
    const envelope = buildEnvelope({
      outcome: runOutcome, outcomeClass: outcome.outcomeClass, status: outcome.status,
      errorStage: outcome.errorStage, failingStepId: outcome.failingStepId,
      attempts, thirdTierEnabled: config.thirdTierKeyPresent,
      thirdTierActor: thirdTier?.actor ?? null, thirdTierOutcome: thirdTier?.outcome ?? null,
      escalation, outcomeHistory: history, recordPath,
      patch: patch ?? null,
      nFailingTests: outcome.nFailingTests, verified: false,
    });
    // The invariant is a presence rule, asserted here so a broken loop cannot
    // print a lying envelope (FYR-294's refinement of FYR-250).
    const expected = expectedHistoryLength(envelope.attempts, envelope.third_tier.outcome);
    if (envelope.outcome_history.length !== expected) {
      throw new Error(
        `outcome-history invariant broken: history has ${envelope.outcome_history.length} entries, expected ${expected} (attempts.total = ${envelope.attempts.total}, third_tier.outcome = ${envelope.third_tier.outcome})`,
      );
    }
    return { envelope, snapshot: snapshotText };
  }
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