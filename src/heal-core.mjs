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
  attempts, // {n_primary, n_fallback}
  targetUrl,
  snapshotText,
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
  lines.push('## error');
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
      }
    } else {
      const ref = r.result.refusal ?? { class: r.result.class, reason: r.result.reason };
      lines.push(`- rung ${r.rung}: no_proposal — ${ref.class}: ${ref.reason}`);
    }
  }
  lines.push(`attempts: n_primary=${attempts.n_primary} n_fallback=${attempts.n_fallback}`);
  lines.push('');
  lines.push('## page state (fresh snapshot at heal time)');
  lines.push(snapshotText ?? '<no snapshot>');
  lines.push('');
  return lines.join('\n');
}

/**
 * The contract_version 2 outcome envelope (FYR-250/257/294 shape, heal slice).
 * Only not_pass outcomes enter the loop; third_tier stays key-gated presence
 * in this slice (the escalation router is a later ticket).
 */
export function buildEnvelope({
  outcome,
  outcomeClass,
  status,
  errorStage,
  failingStepId,
  attempts, // {n_primary, n_fallback}
  thirdTierEnabled,
  recordPath,
  patch, // {stepId, oldLocator, newLocator, changed} | null
  nFailingTests,
  verified,
}) {
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
      third_tier: { enabled: thirdTierEnabled, actor: null, outcome: null },
    },
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