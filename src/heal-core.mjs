// Heal core (FYR-331): the pure half of the heal subcommand.
//
//   parseProposal(raw)      — model output -> {step_id, locator} data, or a
//                             refusal classified stuck | banned
//   patchLocator(source, …) — text surgery: one token anchor, one locator
//                             slot, balanced replacement
//   buildHealRecord(...)    — the .heal.md audit record
//   buildEnvelope(...)      — the contract_version 2 outcome envelope
//
// The healer returns DATA, never code (FYR-250): a structural change is
// unrepresentable in {step_id, locator}, so nothing has to detect it after
// the fact — extra fields or code-shaped payloads are refused outright.
// Lint-rejected proposals count as no_proposal but are recorded distinctly
// (banned = the model violated the locator grammar; stuck = the model could
// not or did not propose). Nothing here repairs: a refusal is an outcome.

import { lintLocator } from './plan-parse.mjs';

const STEP_ID_RE = /^s\d+$/;

/** The healer's system prompt: the grammar the proposal must satisfy. */
export const HEALER_PROMPT = `You heal a failing Playwright test step by re-addressing it, never restructuring it.
You receive the accessibility snapshot of the current page and the failing step.
Return ONLY one JSON object, no prose and no markdown fences. Exactly two keys:

  {"step_id": "<the failing step's id, verbatim>", "locator": "<the corrected locator>"}

If the page genuinely has no element the step could address, return {"step_id": "<id>", "locator": null}.

The locator must be ONE expression built only from: getByRole, getByLabel,
getByPlaceholder, getByAltText, getByTitle, getByText, getByTestId — optionally
chained with .filter({ hasText: '<str>' }), .first(), .last(), .nth(<n>) and
further getBy* calls. Every argument is a literal string or number in single
quotes; no variables, no template literals, no regex, no engine prefixes
(css=/xpath=/id=/text=), no page.locator, no waits, no scroll.
You may never propose code, new steps, assertions, timeouts, or anything other
than a corrected locator for the given step_id.`;

/**
 * The user turn: the failing step's facts (from the trace) + the fresh page.
 * @param {object} step - {id, action, locator, stage, errorMessage}
 * @param {string} snapshotText - the ref-based accessibility snapshot YAML
 */
export function buildRungTurn(step, snapshotText) {
  return `FAILING STEP
  id: ${step.id}
  action: ${step.action}
  current locator: ${step.locator ?? '<none in the plan>'}
  stage: ${step.stage}
  error: ${step.errorMessage}

CURRENT PAGE — ACCESSIBILITY SNAPSHOT (fresh, taken now)
${snapshotText}`;
}

/**
 * Rung 2's user turn (FYR-250's ladder): the same facts + snapshot, plus WHY
 * the previous attempt failed — data already in hand (the rung-1 verdict),
 * zero new machinery. An attempt is allowed only if its input differs from
 * the previous attempt (FYR-250); this block is the difference.
 * @param {object} step - same shape as buildRungTurn
 * @param {string} snapshotText
 * @param {string} whyFailed - one-line harness verdict on attempt 1
 */
export function buildRungTwoTurn(step, snapshotText, whyFailed) {
  return `${buildRungTurn(step, snapshotText)}

WHY THE PREVIOUS ATTEMPT FAILED
${whyFailed}`;
}

/**
 * The third tier's rich-context user turn (FYR-294): strictly more input
 * than the Ollama pair's last attempt — snapshot + why the pair failed + ALL
 * of the pair's failed proposals. Same healer interface (HEALER_PROMPT),
 * data not code.
 * @param {object} step - same shape as buildRungTurn
 * @param {string} snapshotText
 * @param {string} whyFailed
 * @param {Array} failedProposals - [{actor, stepId, locator, verdict}] — what
 *        the Ollama pair proposed and how it was rejected (may be empty)
 */
export function buildThirdTierTurn(step, snapshotText, whyFailed, failedProposals) {
  const proposalLines = (failedProposals ?? []).map((p) =>
    `  - [${p.actor}] proposed ${p.stepId} ${p.locator} — verdict: ${p.verdict}`,
  );
  return `${buildRungTurn(step, snapshotText)}

WHY THE PREVIOUS ATTEMPTS FAILED
${whyFailed}

THE FAILED PROPOSALS THE PREVIOUS MODELS MADE (do not repeat them)
${proposalLines.length > 0 ? proposalLines.join("\n") : "  (none — the previous attempts produced no usable proposal)"}`;
}

/**
 * Parse + validate the raw model response against the proposal contract.
 * @param {string} raw - the completion content, validated AS-IS (no
 *        fence-stripping, no repair — honesty over convenience)
 * @param {{knownIds: string[]}} ctx - ids the spec actually carries
 * @returns {ok:true, proposal:{stepId, locator}} |
 *          {ok:false, refusal:{class:'stuck'|'banned', reason, raw}}
 *
 * stuck   — the model could not or did not answer in the contract's shape
 *           (empty, unparseable, declared "no locator")
 * banned  — the model answered but violated the contract (unknown id,
 *           grammar-violating locator, extra/code-shaped fields)
 */
export function parseProposal(raw, { knownIds }) {
  const text = String(raw ?? '').trim();
  if (text === '') {
    return { ok: false, refusal: { class: 'stuck', reason: 'empty_response', raw: '' } };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, refusal: { class: 'stuck', reason: 'unparseable_response', raw: text.slice(0, 2000) } };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, refusal: { class: 'stuck', reason: 'not_an_object', raw: text.slice(0, 2000) } };
  }

  const keys = Object.keys(parsed);
  const extra = keys.filter((k) => k !== 'step_id' && k !== 'locator');
  if (extra.length > 0) {
    // Code-shaped payloads, structural suggestions, annotations — anything
    // outside the two-key contract is a refusal, not something to inspect.
    return { ok: false, refusal: { class: 'banned', reason: `extra_fields: ${extra.join(', ')}`, raw: text.slice(0, 2000) } };
  }

  const stepId = parsed.step_id;
  if (typeof stepId !== 'string' || !STEP_ID_RE.test(stepId)) {
    return { ok: false, refusal: { class: 'banned', reason: `step_id not of the form s<N>: ${JSON.stringify(stepId)}`, raw: text.slice(0, 2000) } };
  }
  if (!knownIds.includes(stepId)) {
    return { ok: false, refusal: { class: 'banned', reason: `step_id ${stepId} is not a step this spec carries (ids: ${knownIds.join(', ')})`, raw: text.slice(0, 2000) } };
  }

  const locator = parsed.locator;
  if (locator === null || locator === undefined) {
    return { ok: false, refusal: { class: 'stuck', reason: 'model_returned_nothing', raw: text.slice(0, 2000) } };
  }
  if (typeof locator !== 'string' || locator.trim() === '') {
    return { ok: false, refusal: { class: 'banned', reason: 'locator is not a non-empty string', raw: text.slice(0, 2000) } };
  }

  const lint = lintLocator(locator.trim());
  if (!lint.ok) {
    return { ok: false, refusal: { class: 'banned', reason: `locator rejected by the grammar: ${lint.problem}`, raw: text.slice(0, 2000) } };
  }

  return { ok: true, proposal: { stepId, locator: locator.trim() } };
}

// ------------------------------------------------------------ patch surgery

// The compiled spec's three slot shapes (src/compile-spec.mjs), each anchored
// on its exact emission:
//     await page.<slot>.click();
//     await page.<slot>.fill(<rhs>);
//     await expect(page.<slot>).toBeVisible();
// The slot is one expression on one line (lintSpec enforces it); the patch is
// a balanced splice of the slot text, not a parse of the code.
const CLICK_RE = /^(\s*await page\.)(.*)\.click\(\);$/;
const FILL_RE = /^(\s*await page\.)(.*)\.fill\((.*)\);$/;
const EXPECT_RE = /^(\s*await expect\(page\.)(.*)(\)\.\w+\(\);)$/;

/**
 * Replace the failing step's single locator slot.
 * @param {string} specSource - the stamped spec source
 * @param {string} stepId - 'sN' — the token anchor
 * @param {string} newLocator - grammar-validated locator expression
 * @returns {ok:true, source, oldLocator, changed} |
 *          {ok:false, reason} — refusals are outcomes, not exceptions
 *
 * Refusal reasons: no_anchor (the [sN] token is absent), no_slot,
 * multi_slot (the patcher would have to guess), unbalanced_slot.
 */
export function patchLocator(specSource, stepId, newLocator) {
  const lines = specSource.split('\n');
  const tokenRe = new RegExp(`test\\.step\\('\\[${stepId}\\] `);
  const anchorIdx = lines.findIndex((l) => tokenRe.test(l));
  if (anchorIdx === -1) {
    return { ok: false, reason: `no_anchor: no test.step('[${stepId}] …') in the spec` };
  }

  // The step's body runs to its closing `  });` (the compiler's emission shape).
  let endIdx = -1;
  for (let i = anchorIdx + 1; i < lines.length; i++) {
    if (lines[i] === '  });') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { ok: false, reason: 'no_anchor_end: the step body has no closing brace line — not a compiler-shaped spec' };
  }

  const slotIdxs = [];
  for (let i = anchorIdx; i <= endIdx; i++) {
    if (/\bgetBy[A-Z]\w*\(/.test(lines[i]) && (CLICK_RE.test(lines[i]) || FILL_RE.test(lines[i]) || EXPECT_RE.test(lines[i]))) {
      slotIdxs.push(i);
    }
  }
  if (slotIdxs.length === 0) {
    return { ok: false, reason: `no_slot: step [${stepId}] carries no single-line locator slot` };
  }
  if (slotIdxs.length > 1) {
    return { ok: false, reason: `multi_slot: step [${stepId}] spans ${slotIdxs.length} locator lines — refusing to guess` };
  }

  const idx = slotIdxs[0];
  const line = lines[idx];
  let oldLocator;
  let rebuilt;
  if (EXPECT_RE.test(line)) {
    const m = line.match(EXPECT_RE);
    oldLocator = m[2];
    rebuilt = `${m[1]}${newLocator}${m[3]}`;
  } else if (FILL_RE.test(line)) {
    const m = line.match(FILL_RE);
    oldLocator = m[2];
    rebuilt = `${m[1]}${newLocator}.fill(${m[3]});`;
  } else {
    const m = line.match(CLICK_RE);
    oldLocator = m[2];
    rebuilt = `${m[1]}${newLocator}.click();`;
  }

  if (!oldLocator || !/[)\w]$/.test(oldLocator)) {
    return { ok: false, reason: 'unbalanced_slot: the extracted slot does not end in a call' };
  }

  const out = lines.slice();
  out[idx] = rebuilt;
  return {
    ok: true,
    source: out.join('\n'),
    oldLocator,
    changed: oldLocator !== newLocator,
    lineNo: idx + 1,
  };
}

// ------------------------------------------------------------ escalation

/**
 * The escalation router (FYR-257, test-profile table): pure per-reason, never
 * outcome-aware. 257 fills `disposition`; the loop acts on the return. 257
 * never sees outcomes — the loop derives the reason from loop-state.
 *
 * @param {{reason: string, thirdTierEnabled: boolean}} opts
 * @returns {{retryThirdTier: boolean, disposition: "prompt"}
 *           | {retryThirdTier: false, disposition: null, fatal: true}
 *           — null disposition = loud-fatal contract gap (Q3): the caller
 *           must halt the run loudly, never fall back silently.
 *
 * The table (test v1):
 *   budget_exhausted    → Retry(third_tier) if enabled, else Terminal(prompt)
 *   fallback_exhausted  → Retry(third_tier) if enabled, else Terminal(prompt)
 *   infra               → Terminal(prompt) — capability valve, not availability
 *   non_retryable       → null → loud-fatal (owned solely by browsing; test
 *                         v1 never produces it — if it ever shows up, halt)
 * Unknown reasons are loud-fatal too: the unknown-upstream default is
 * fallback-not-classification, never an invented route.
 */
export function routeEscalation({ reason, thirdTierEnabled }) {
  if (reason === "budget_exhausted" || reason === "fallback_exhausted") {
    if (thirdTierEnabled) return { retryThirdTier: true, disposition: null };
    return { retryThirdTier: false, disposition: "prompt" };
  }
  if (reason === "infra") {
    return { retryThirdTier: false, disposition: "prompt" };
  }
  // non_retryable + anything unknown: no disposition in the active profile —
  // a contract gap fails the run, it is not a fallback value (257 Q3).
  return { retryThirdTier: false, disposition: null, fatal: true };
}

/**
 * The escalation reason from loop-state (FYR-250: built from attempts, budget,
 * actor — never from outcome values). Test profile: `non_retryable` is
 * unreachable (owned by browsing), `infra` comes only from the environment
 * (the browser bridge), handled by the caller before the ladder runs.
 * Precedence infra > non_retryable > fallback_exhausted > budget_exhausted:
 * with infra already extracted, any fallback engagement outranks plain
 * budget exhaustion.
 * @param {{fallbackEngaged: boolean}} loopState
 */
export function deriveEscalationReason({ fallbackEngaged }) {
  return fallbackEngaged ? "fallback_exhausted" : "budget_exhausted";
}

/**
 * One outcome-history entry (FYR-250 schema, v1 heal vocabulary).
 * Per-attempt outcome values (additive, never re-classed — the monotone
 * invariant binds the RUN-level enum, and these are new attempt-level
 * values): "errored" (the call failed), "no_proposal" (refused/declared
 * nothing), "patch_refused" (the patcher refused), "compile_failed"
 * (patch applied but the spec no longer compiles), "healed".
 */
export function historyEntry(attempt, actor, outcome) {
  return { attempt, actor, outcome, ts: new Date().toISOString() };
}

/**
 * The outcome-history length invariant (FYR-294's refinement of FYR-250):
 *   length == attempts.total - (third_tier.outcome ∈ {"no_proposal","errored"} ? 1 : 0)
 * A third-tier no_proposal/errored was invoked but never ran a Playwright
 * attempt — the deficit. Exported so tests assert the invariant, not a
 * re-derivation of it.
 */
export function expectedHistoryLength(attempts, thirdTierOutcome) {
  const deficit = thirdTierOutcome === "no_proposal" || thirdTierOutcome === "errored" ? 1 : 0;
  return attempts.total - deficit;
}

// --------------------------------------------------------------- artifacts

/**
 * Build the .heal.md record — the audit trail for one non-pass outcome.
 * Everything in it is harness-derived (trace facts + what actually happened);
 * the model's words appear only as the proposal it returned, classified.
 */
export function buildHealRecord({
  runId,
  reportSha,
  headSha,
  specPath,
  planPath,
  outcome, // healed | no_proposal | patch_refused | compile_failed
  outcomeClass,
  status,
  errorStage,
  failingStep,
  // {id, action, locator}
  failedLocator, // from the trace's call log
  attemptedIds,
  rungs, // [{rung, result}] — result: {proposal} | {refusal}
  attempts, // {n_primary, n_fallback, total, third_tier}
  targetUrl,
  snapshotText,
  thirdTier, // {actor, outcome, proposal?, refusal?, error} | null
  escalation, // {reason, disposition} | null — the one event, at the terminal
}) {
  const stamp = (sha) => (sha ? sha.slice(0, 7) : '<none>');
  const lines = [];
  lines.push(`# heal record`);
  lines.push(`run_id: ${runId}`);
  lines.push(`report_sha: ${stamp(reportSha)}`);
  lines.push(`head_sha: ${stamp(headSha)}`);
  lines.push(`spec: ${specPath}`);
  lines.push(`plan: ${planPath}`);
  lines.push(`contract_version: 2`);
  lines.push(`outcome: ${outcome}`);
  lines.push(`outcome_class: ${outcomeClass}`);
  lines.push(`status: ${status ?? '<none>'}`);
  lines.push(`error_stage: ${errorStage ?? '<none>'}`);
  lines.push(`target_url: ${targetUrl ?? '<unresolved>'}`);
  lines.push('');
  lines.push(`failing_step: ${failingStep?.id ?? '<none>'}`);
  lines.push(`failing_action: ${failingStep?.action ?? '<none>'}`);
  lines.push(`failed_locator: ${failedLocator ?? '<none in call log>'}`);
  lines.push(`steps_attempted: ${attemptedIds.length ? attemptedIds.join(' ') : '<none>'}`);
  lines.push('');
  lines.push(`## error`);
  lines.push(failingStep?.errorMessage?.trim() || '<no error text>');
  lines.push('');
  lines.push('## ladder');
  if (rungs.length === 0) lines.push('(no rung entered)');
  for (const r of rungs) {
    if (r.result.proposal) {
      const p = r.result.proposal;
      lines.push(`- rung ${r.rung}: proposal ${p.stepId} ${p.locator} — lint passed${r.result.changed === false ? ' (locator unchanged — no-op patch)' : ''}`);
      if (r.result.compileError) {
        lines.push(`  compile check FAILED — patch reverted: ${String(r.result.compileError).split('\n')[0].slice(0, 200)}`);
      } else if (r.result.reason) {
        lines.push(`  patch refused — ${r.result.reason}`);
      }
    } else {
      const ref = r.result.refusal ?? { class: r.result.class, reason: r.result.reason };
      lines.push(`- rung ${r.rung}: no_proposal — ${ref.class}: ${ref.reason}`);
    }
  }
  lines.push(`attempts: n_primary=${attempts.n_primary} n_fallback=${attempts.n_fallback} third_tier=${attempts.third_tier}`);
  lines.push('');
  if (thirdTier) {
    lines.push('## third tier');
    lines.push(`actor: ${thirdTier.actor}`);
    lines.push(`outcome: ${thirdTier.outcome}`);
    if (thirdTier.proposal) {
      lines.push(`proposal: ${thirdTier.proposal.stepId} ${thirdTier.proposal.locator}${thirdTier.compileError ? ` — compile check FAILED, patch reverted: ${String(thirdTier.compileError).split('\n')[0].slice(0, 200)}` : ''}`);
    }
    if (thirdTier.refusal) {
      lines.push(`refusal: ${thirdTier.refusal.class}: ${thirdTier.refusal.reason}`);
    }
    if (thirdTier.error) {
      lines.push(`call failed: ${thirdTier.error}`);
    }
    lines.push('');
  }
  if (escalation) {
    lines.push('## escalation');
    lines.push(`reason: ${escalation.reason}`);
    lines.push(`disposition: ${escalation.disposition}`);
    lines.push('');
  }
  lines.push('## page state (fresh snapshot at heal time)');
  lines.push(snapshotText ?? '<no snapshot>');
  lines.push('');
  return lines.join('\n');
}

/**
 * The contract_version 2 outcome envelope (FYR-250/257/294 shape, heal slice).
 * Only not_pass outcomes enter the loop.
 *
 * FYR-294's schema extension, enforced here:
 *   attempts.third_tier ∈ {0, 1} (invocations) + a top-level third_tier block
 *   {enabled, actor, outcome} present always:
 *     enabled == false            ⇒ attempts.third_tier == 0
 *     attempts.third_tier == 0    ⇒ actor == null && outcome == null
 *     attempts.third_tier == 1    ⇒ actor != null && outcome != null
 *     outcome ∈ {failed, no_proposal, errored} on a terminal — "healed" only
 *     on the healed envelope (success → no escalation event, audited in the
 *     .heal.md).
 *   escalation — exactly one, at the true terminal (null on healed/no-event).
 *   outcome_history.length == attempts.total minus the third-tier no-run
 *   deficit (expectedHistoryLength).
 */
export function buildEnvelope({
  outcome,
  outcomeClass,
  status,
  errorStage,
  failingStepId,
  attempts, // {n_primary, n_fallback, third_tier}
  thirdTierEnabled,
  thirdTierActor, // resolved model id when the tier was invoked
  thirdTierOutcome, // failed | no_proposal | errored | healed | null
  escalation, // {event, reason, profile, disposition, ts} | null
  outcomeHistory, // [{attempt, actor, outcome, ts}]
  recordPath,
  patch, // {stepId, oldLocator, newLocator, changed} | null
  nFailingTests,
  verified,
}) {
  const total = attempts.n_primary + attempts.n_fallback + attempts.third_tier;
  // Presence rules (294): count 0 ⇒ actor/outcome null; count 1 ⇒ both set.
  const invoked = attempts.third_tier === 1;
  const block = {
    enabled: thirdTierEnabled === true,
    actor: invoked ? (thirdTierActor ?? null) : null,
    outcome: invoked ? (thirdTierOutcome ?? null) : null,
  };
  if (block.enabled === false && attempts.third_tier !== 0) {
    throw new Error(`third-tier presence rule broken: enabled == false requires attempts.third_tier == 0 (got ${attempts.third_tier})`);
  }
  if (invoked && (!block.actor || !block.outcome)) {
    throw new Error("third-tier presence rule broken: attempts.third_tier == 1 requires actor and outcome");
  }
  if (!invoked && (block.actor !== null || block.outcome !== null)) {
    throw new Error("third-tier presence rule broken: attempts.third_tier == 0 requires actor == null and outcome == null");
  }
  return {
    contract_version: 2,
    command: 'heal',
    outcome,
    outcome_class: outcomeClass,
    status,
    error_stage: errorStage ?? null,
    failing_step: failingStepId ?? null,
    attempts: {
      n_primary: attempts.n_primary,
      n_fallback: attempts.n_fallback,
      total,
      third_tier: attempts.third_tier,
    },
    third_tier: block,
    escalation: escalation ?? null,
    outcome_history: outcomeHistory ?? [],
    patch: patch
      ? { step_id: patch.stepId, old_locator: patch.oldLocator, new_locator: patch.newLocator, changed: patch.changed }
      : null,
    record: recordPath ?? null,
    n_failing_tests: nFailingTests ?? 1,
    // Honesty rule: heal never claims the suite now passes — verification is
    // the consumer's rerun of the patched spec.
    verified: verified === true,
  };
}