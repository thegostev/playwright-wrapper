// Plan emission (FYR-329): snapshot + grammar in, plan text out.
//
// The FYR-324 spike proved the shape (5/5 raw responses passing the full
// grammar unmodified); this module is that spike's pairing, in the lib:
//
//   - system turn: the FYR-267 locator grammar, exactly as
//     src/plan-parse.mjs enforces it (lifted verbatim from the spike)
//   - user turn: the live accessibility snapshot + the human's NL goal
//   - the RAW response is validated unmodified by checkPlan() — zero repair,
//     no fence-stripping, no retry-until-pass (honesty over convenience)
//   - step ids are harness-assigned: the model's ids are ignored, steps are
//     re-keyed s1..sN in order and header next_id recomputed as the
//     high-water mark + 1 (the model never authors or mutates ids)
//
// On any grammar violation the caller gets {ok:false, problems} with the
// problems already carrying line numbers — print and exit non-zero.

import { checkPlan, parsePlan } from "./plan-parse.mjs";

// The grammar prompt: the enforcement spec, lifted verbatim from the
// FYR-324 emission spike (spike/plan-emit.mjs) so a grammar change happens
// in one place at a time. It ends by requiring ONLY the plan text.
export const GRAMMAR = `You write test plans in a strict line-oriented grammar. The plan is validated mechanically; ANY violation below is a hard rejection. Output ONLY the plan text — no prose, no markdown code fences.

FORMAT (line-oriented, ASCII-only, LF line endings, no trailing whitespace on any line):

profile: test
title: <lowercase human title>
file: <lowercase-slug-with-hyphens>
next_id: <sN greater than every step id>
---
## steps

- id: s1
  action: <imperative description, unique across steps>
  locator: <see below>
  value: <see below>
- id: s2
  ...

HEADER (closed schema, exactly these four keys, this order):
- profile: test   (always exactly "test")
- title: short title
- file: slug matching ^[a-z0-9][a-z0-9-]*$
- next_id: s<N> where N is strictly greater than every step number

STEPS:
- Opening line is exactly "- id: sN" with no space before "-" and exactly one space after ":"
- Continuation lines are indented exactly 2 spaces, form "key: value"
- Allowed keys in each step (at most once each): action, locator, value, expect, reason
- "action" is required on every step
- "locator" is required on every step — write "locator: none" for a step with no element

LOCATOR (when not "none") — one expression, built only from:
- Root: getByRole('role', { name: '<str>' }) [exact role names: button, link, heading, textbox, checkbox, combobox, listbox, option, listitem, table, tab, dialog, row, cell, columnheader, navigation, banner, main, search, form, label, img, list, menu, generic]
- or one of: getByLabel('<str>'), getByPlaceholder('<str>'), getByAltText('<str>'), getByTitle('<str>'), getByText('<str>'), getByTestId('<str>')
- Chained with dots: .filter({ hasText: '<str>' }), .first(), .last(), .nth(<n>), or another getBy* call (e.g. getByRole('listitem').filter({ hasText: 'x' }).getByRole('link'))
- EVERY argument is a single-quoted string literal or plain number. NO variables, NO template literals, NO regex, NO engine prefixes (css=, xpath=, id=, text=), NO page.locator(), NO frameLocator(), NO backticks, NO interpolation.
- Strings must not contain a single quote (not expressible in this grammar).
- .first()/.last()/.nth() require a non-empty "reason:" naming the position.

VALUE (for input steps — never combine "value:" and "expect:" in one step):
- value: literal '<str>'   (a quoted literal, e.g. value: literal 'engineer')
- value: env:E2E_NAME      (name matches ^E2E_[A-Z0-9_]+$, e.g. E2E_USER)

EXPECT (for assertion steps):
- locator-bearing: expect: visible | hidden | enabled | disabled | checked | unchecked | text '<str>' | contains '<str>' | value '<str>' | count <n>
- page-level (only with locator: none): expect: url '<str>' | title '<str>'
- expect: hidden requires a non-empty "reason:" explaining why this absence-proof is real
- an expect that needs an element must NOT be on a locator: none step, and vice versa

REASON: optional short justification (ASCII, one line).

Full example (DIFFERENT site — format illustration only):

profile: test
title: user can sign in
file: user-can-sign-in
next_id: s6
---
## steps

- id: s1
  action: go to the login page
  locator: none
  value: literal '/'
- id: s2
  action: fill the email field
  locator: getByLabel('Email')
  value: env:E2E_USER
  reason: label present on the form
- id: s3
  action: submit the form
  locator: getByRole('button', { name: 'Sign in' })
  reason: role=button, name="Sign in"
- id: s4
  action: assert the dashboard heading is shown
  locator: getByRole('heading', { name: 'Dashboard' })
  expect: visible
  reason: role=heading`;

// The task turn: snapshot + the human's goal. Locators must reference
// elements that actually appear in the snapshot; relative URLs only.
export function buildTaskTurn(snapshot, goal, target) {
  return `TASK: Below is the accessibility-snapshot YAML of one real page (currently at ${target}). Write a plan (in the grammar above) for ONE focused E2E test against this page. THE TEST MUST COVER THIS GOAL (write the plan for this goal, not merely for whatever the page offers): ${goal}

Keep it focused (4-9 steps). Every locator must reference elements that actually appear in this snapshot (use their accessible names). Do not invent steps the page cannot support; relative URLs only ('/' + path).

SNAPSHOT:
${snapshot}`;
}

/**
 * Re-key a plan's step ids: the model's ids are ignored; steps are numbered
 * s1..sN in order and header next_id is the high-water mark + 1. The model
 * never authors or mutates ids (FYR-325 Implementation Decisions).
 *
 * Takes the RAW text, swaps every "- id: ..." token in order, recomputes
 * next_id, and returns the re-keyed plan text. If the raw text doesn't parse
 * as a plan at all, returns null — the caller reports the raw checkPlan
 * problems instead (re-keying is not a repair, it is only defined for a
 * parseable plan).
 */
export function rekeyPlanIds(rawPlanText) {
  let parsed;
  try {
    parsed = parsePlan(rawPlanText);
  } catch {
    return null; // unparseable — the raw problems tell the story
  }
  void parsed;
  const lines = rawPlanText.split('\n');
  let n = 0;
  const out = lines.map((line) => {
    const m = line.match(/^(\s*)- id:\s*(\S+)\s*$/);
    if (!m) return line;
    n += 1;
    return `${m[1]}- id: s${n}`;
  });
  // next_id: high-water mark + 1 (n steps → next_id: s<n+1>)
  const nextIdLine = out.findIndex((line) => /^next_id:/.test(line));
  if (nextIdLine === -1) return null; // header schema violation — let checkPlan report it
  out[nextIdLine] = `next_id: s${n + 1}`;
  return out.join('\n');
}

/**
 * Emit a plan: raw model response in, verdict out. The response is validated
 * UNMODIFIED (headline); no repair, no normalization of any kind.
 *
 * @returns {{ok: true, plan: object, planText: string, envNames: string[]}
 *          | {ok: false, problems: string[], raw: string}}
 */
export function emitVerdict(rawResponse) {
  // Re-key ids (harness-assigned identities), then validate the re-keyed
  // text. The re-keyed text is what the consumer reviews and approves.
  const rekeyed = rekeyPlanIds(rawResponse);
  if (rekeyed === null) {
    const v = checkPlan(rawResponse);
    return { ok: false, problems: v.problems ?? ['unparseable'], raw: rawResponse };
  }
  const verdict = checkPlan(rekeyed);
  if (!verdict.ok) {
    return { ok: false, problems: verdict.problems, raw: rawResponse };
  }
  return { ok: true, plan: verdict.plan, planText: rekeyed, envNames: verdict.envNames };
}
