// Emission spike (pre-FYR-ticket): can glm-5.3-flash:cloud, given a real
// snapshot and the FYR-267 grammar, emit a plan that passes
// checkPlan() (parsePlan + validatePlan from src/plan-parse.mjs) UNMODIFIED?
//
// Zero model-side help beyond the prompt; zero harness repair. The headline
// metric is the raw response fed to checkPlan() as-is. As a secondary
// diagnostic only, we also record the plan after stripping markdown code
// fences (a normalization a real CLI might allow) — clearly labeled.
//
// Run: node spike/plan-emit.mjs [nTrials]

import { checkPlan } from '../src/plan-parse.mjs';
import { readFileSync } from 'node:fs';

const MODEL = process.env.PLAN_EMIT_MODEL ?? 'glm-5.3-flash:cloud';
const TRIALS = Number(process.argv[2] ?? 5);
const API = 'https://ollama.com/v1/chat/completions';

const snapshot = readFileSync(new URL('./snap-fortum.yaml', import.meta.url), 'utf8');

// The 267 grammar, as enforced by src/plan-parse.mjs (parsePlan + validatePlan).
const GRAMMAR = `You write test plans in a strict line-oriented grammar. The plan is validated mechanically; ANY violation below is a hard rejection. Output ONLY the plan text — no prose, no markdown code fences.

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

const TASK = `TASK: Below is the accessibility-snapshot YAML of one real page (a job board's search page). Write a plan (in the grammar above) for ONE focused E2E test against this page: search for a job by keyword, run the search, and assert the results list shows matching roles. Keep it 4-7 steps. Every locator must reference elements that actually appear in this snapshot (use their accessible names). Do not invent steps the page cannot support; relative URLs only ('/' + path).

SNAPSHOT:
${snapshot}`;

async function emit() {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: GRAMMAR },
        { role: 'user', content: TASK },
      ],
    }),
  });
  const body = await res.json();
  if (!res.ok) return { ok: false, http: res.status, body };
  const raw = body.choices[0].message.content;
  const verdict = checkPlan(raw);
  // Secondary diagnostic only: strip `` fences if present.
  const stripped = raw
    .replace(/^\s*```[^\n]*\n/, '')
    .replace(/\n```\s*$/, '');
  const strippedVerdict = stripped === raw ? null : checkPlan(stripped);
  return { ok: true, raw, verdict, strippedVerdict, model: body.model, usage: body.usage };
}

let passes = 0;
const details = [];
for (let t = 1; t <= TRIALS; t++) {
  const r = await emit();
  if (!r.ok) {
    details.push(`trial ${t}: HTTP ${r.http} — ${(r.body && r.body.error && r.body.error.message) || JSON.stringify(r.body).slice(0, 200)}`);
    continue;
  }
  const pass = r.verdict.ok;
  if (pass) passes++;
  let line = `trial ${t}: ${pass ? 'PASS' : 'FAIL'} (model echoed: ${r.model}; ${r.usage?.total_tokens ?? '?'} tokens)`;
  if (r.strippedVerdict) line += ` | fence-stripped: ${r.strippedVerdict.ok ? 'PASS' : 'FAIL'}`;
  details.push(line);
  if (!pass) for (const p of (r.verdict.problems ?? []).slice(0, 5)) details.push(`    - ${p}`);
  if (!pass && !r.strippedVerdict) {
    // Keep one failing raw response on disk for inspection (first failure only).
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(new URL('./plan-emit-fail.yaml', import.meta.url), r.raw);
    } catch {}
    details.push('    (raw response saved to spike/plan-emit-fail.yaml)');
    r.strippedVerdict; // no-op
    details[details.length - 1] = details[details.length - 1];
  }
}
console.log(`\n=== ${MODEL}: ${passes}/${TRIALS} raw plans passed checkPlan() unmodified ===`);
for (const d of details) console.log(d);