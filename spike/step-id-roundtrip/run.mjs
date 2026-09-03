// Spike: step-id roundtrip (FYR-267). Zero model — no LLM, no Ollama, no MCP.
//
// Proves, end to end with stock Playwright (`--reporter=json`), that the
// generator output contract is *implementable*:
//
//   read half : a failing step's id is recoverable from results.json — the id
//               rides the test.step title, and the failing step carries the
//               error. The JSON contains ONLY test.step entries (Playwright's
//               own expect/API steps are filtered out by the reporter), so the
//               outermost step matching ^\[(s\d+)\] is the failure's address.
//   write half: the runner patches the named step's single locator slot by
//               text surgery (id token -> unique anchor; one slot per step ->
//               one replacement target), reruns, and the test passes.
//   refusals  : a duplicate [s2] token makes the patch scan ambiguous ->
//               refuse loud; a step without an id token fails spec lint ->
//               refuse before any patch.
//
// What it does NOT prove: that a generator (LLM) can *produce* this encoding.
// The pair is hand-crafted; the encoding round-trips, nothing more.
//
// Run from the repo root:  node spike/step-id-roundtrip/run.mjs
// Artifacts: a throwaway consumer project in spike/step-id-roundtrip/consumer/
// (gitignored) and traces in spike/traces/fyr267-*.json.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';

import { checkPlan, lintSpec, lintLocator } from '../../src/plan-parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const CONSUMER = join(HERE, 'consumer');
const PLAN_SRC = join(HERE, 'sign-in.plan.md');
const PW_CLI = join(REPO, 'node_modules', 'playwright', 'cli.js');
const TRACES = join(REPO, 'spike', 'traces');

const failures = [];
const notes = [];
function check(name, cond, detail = '') {
  (cond ? notes : failures).push(`${cond ? 'ok' : 'FAIL'} — ${name}${detail ? ` — ${detail}` : ''}`);
}

// ------------------------------------------------------------ the artifacts

// The stamped pair. Hand-crafted (this spike never calls a model). The spec's
// first line carries the plan's sha256 — the FYR-268 tie — recomputed here
// from the plan's exact bytes, the same way the CI lint will recompute it.
// The one intentional defect: s4's locator names 'Log in', while the page's
// button says 'Sign in'. The first run fails at s4; the patch heals it.
const SPEC_TEMPLATE = `// plan-sha256: __PLAN_SHA__
import { test, expect } from '@playwright/test';

const E2E_USER = process.env.E2E_USER;
if (!E2E_USER) throw new Error('missing env var E2E_USER');

test('user can sign in', async ({ page }) => {
  await test.step('[s1] go to the login page', async () => {
    await page.goto('/');
  });
  await test.step('[s2] fill the email field', async () => {
    await page.getByLabel('Email').fill(E2E_USER);
  });
  await test.step('[s3] fill the password field', async () => {
    await page.getByLabel('Password').fill('correct horse');
  });
  await test.step('[s4] submit the form', async () => {
    await page.getByRole('button', { name: '__BUTTON_NAME__' }).click();
  });
  await test.step('[s5] assert the dashboard heading is shown', async () => {
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});
`;

const REFUSAL_DUPLICATE = `// plan-sha256: __PLAN_SHA__
import { test, expect } from '@playwright/test';

test('duplicate token', async ({ page }) => {
  await test.step('[s1] go to the login page', async () => {
    await page.goto('/');
  });
  await test.step('[s2] type the first digit', async () => {
    await page.getByLabel('Email').fill('1');
  });
  await test.step('[s2] type the second digit', async () => {
    await page.getByLabel('Email').fill('2');
  });
});
`;

const REFUSAL_MISSING = `// plan-sha256: __PLAN_SHA__
import { test, expect } from '@playwright/test';

test('missing token', async ({ page }) => {
  await test.step('[s1] go to the login page', async () => {
    await page.goto('/');
  });
  await test.step('submit the form', async () => {
    await page.getByRole('button', { name: 'Sign in' }).click();
  });
});
`;

const CONSUMER_CONFIG = `import { defineConfig } from '@playwright/test';

// The consumer config contract in miniature: testDir (FYR-268), baseURL from
// env (FYR-249), captureGitInfo (FYR-302), JSON reporter for CI (FYR-249).
export default defineConfig({
  testDir: '.',
  testMatch: /sign-in\\.spec\\.ts/,
  workers: 1,
  captureGitInfo: true,
  use: { baseURL: process.env.E2E_BASE_URL, actionTimeout: 1500 },
  reporter: [['json', { outputFile: 'results.json' }]],
});
`;

// --------------------------------------------- the heal write-path mechanic

// Text surgery: patch the single locator slot of the step whose title token
// is [stepId]. The anchors are strong by contract: the token is unique
// (boundary validation), the step holds exactly one slot (one-slot rule),
// the slot is literal-only (the Q12 grammar, regex-matchable). Zero anchors,
// two-plus anchors, zero slots, or two-plus slots are all loud refusals —
// never a best-effort patch.
function patchLocatorSlot(source, stepId, newSlot) {
  const lines = source.split('\n');
  const anchor = `test.step('[${stepId}]`;
  const anchors = lines.reduce((acc, line, i) => (line.includes(anchor) ? [...acc, i] : acc), []);
  if (anchors.length === 0) {
    return { ok: false, reason: 'no_anchor', message: `refusing to patch: no step with token [${stepId}]` };
  }
  if (anchors.length > 1) {
    return { ok: false, reason: 'ambiguous_anchor', message: `refusing to patch: token [${stepId}] appears ${anchors.length} times (lines ${anchors.map((i) => i + 1).join(', ')})` };
  }
  const start = anchors[0];
  const endIdx = lines.findIndex(
    (line, i) => i > start && (line.includes('test.step(') || /^\}\);/.test(line)),
  );
  const regionEnd = endIdx === -1 ? lines.length : endIdx;
  const slotLines = [];
  for (let i = start + 1; i < regionEnd; i++) {
    if (/\bgetBy(Role|Label|Placeholder|AltText|Title|Text|TestId)\(/.test(lines[i])) slotLines.push(i);
  }
  if (slotLines.length === 0) {
    return { ok: false, reason: 'no_slot', message: `refusing to patch: step [${stepId}] has no locator slot — a zero-locator step is outside the heal surface` };
  }
  if (slotLines.length > 1) {
    return { ok: false, reason: 'multi_slot', message: `refusing to patch: step [${stepId}] has ${slotLines.length} locator slots — the one-slot rule made this unrepresentable at generate; something hand-broke it` };
  }
  const li = slotLines[0];
  const line = lines[li];
  const from = line.indexOf('page.getBy');
  let depth = 0;
  let to = -1;
  for (let c = line.indexOf('(', from); c < line.length; c++) {
    if (line[c] === '(') depth++;
    if (line[c] === ')') depth--;
    if (depth === 0) { to = c; break; }
  }
  if (to === -1) {
    return { ok: false, reason: 'unbalanced_slot', message: `refusing to patch: the locator slot on line ${li + 1} does not close on one line` };
  }
  lines[li] = line.slice(0, from) + newSlot + line.slice(to + 1);
  return { ok: true, source: lines.join('\n'), line: li + 1 };
}

// Read half: the failing step's id out of results.json. Walk the step tree;
// take the *first* (outermost) node carrying an error whose title matches the
// token regex. Auto-generated expect/API step categories never appear in the
// JSON at all — stepCategoryFilter keeps the tree to test.step entries.
function failingStepId(result) {
  const walk = (steps) => {
    for (const step of steps ?? []) {
      if (step.error && /^\[(s\d+)\]\s/.test(step.title)) return step.title.match(/^\[(s\d+)\]/)[1];
      const inner = walk(step.steps);
      if (inner) return inner;
    }
    return null;
  };
  return walk(result?.steps);
}

// ------------------------------------------------------------------ the run

const server = createServer((req, res) => {
  const file = req.url === '/dashboard' ? 'dashboard.html' : req.url === '/' ? 'index.html' : null;
  if (!file) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(join(HERE, 'site', file)));
});

// Async spawn: a blocking call here starves the in-process HTTP server the
// browser is navigating to.
function runPlaywright() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [PW_CLI, 'test', '--config', 'playwright.config.ts'], {
      cwd: CONSUMER,
      env: { ...process.env, E2E_BASE_URL: BASE_URL, E2E_USER: 'spike@example.com', CI: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const killer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('playwright run timed out')); }, 120_000);
    child.on('error', (err) => { clearTimeout(killer); reject(err); });
    child.on('close', (status) => { clearTimeout(killer); resolvePromise({ status, output: out }); });
  });
}

function readResults() {
  return JSON.parse(readFileSync(join(CONSUMER, 'results.json'), 'utf8'));
}

let BASE_URL;
try {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  BASE_URL = `http://127.0.0.1:${server.address().port}`;

  // Consumer project: plan + stamped spec + config.
  mkdirSync(CONSUMER, { recursive: true });
  const planText = readFileSync(PLAN_SRC, 'utf8');
  const planSha = createHash('sha256').update(planText, 'utf8').digest('hex');
  copyFileSync(PLAN_SRC, join(CONSUMER, 'user-can-sign-in.plan.md'));
  writeFileSync(
    join(CONSUMER, 'user-can-sign-in.spec.ts'),
    SPEC_TEMPLATE.replaceAll('__PLAN_SHA__', planSha).replaceAll('__BUTTON_NAME__', 'Log in'),
  );
  writeFileSync(join(CONSUMER, 'playwright.config.ts'), CONSUMER_CONFIG);

  // 0. The pair passes both lints before anything runs (boundary validation).
  const planCheck = checkPlan(planText);
  check('the hand-crafted plan passes parse + boundary validation', planCheck.ok, planCheck.problems?.join(' | '));
  check('the plan collects the env names for the gate', planCheck.envNames?.join(',') === 'E2E_USER', JSON.stringify(planCheck.envNames));
  {
    const spec = readFileSync(join(CONSUMER, 'user-can-sign-in.spec.ts'), 'utf8');
    const lint = lintSpec(spec);
    check('the failing-spec passes the spec lint (a wrong-but-legal locator is not a lint matter)', lint.ok, lint.problems?.join(' | '));
    // The stamped sha ties the two files.
    check('the spec stamp matches the recomputed plan sha256', spec.startsWith(`// plan-sha256: ${planSha}\n`));
  }

  // 1. First run: fails at [s4]; the id round-trips through results.json.
  const run1 = await runPlaywright();
  const failed = readResults();
  writeFileSync(join(TRACES, 'fyr267-fail-results.json'), JSON.stringify(failed, null, 2));
  const result1 = failed.suites?.[0]?.specs?.[0]?.tests?.[0]?.results?.[0];
  check('first run exits non-zero (the test fails)', run1.status === 1, `exit=${run1.status}`);
  check('first run status is failed', result1?.status === 'failed', `status=${result1?.status}`);
  const titles1 = (result1?.steps ?? []).map((s) => s.title);
  check(
    'the JSON carries ONLY test.step entries — every step title is a [sN] token (reporter filters expect/API steps)',
    titles1.length >= 1 && titles1.every((t) => /^\[s\d+\]\s/.test(t)),
    JSON.stringify(titles1),
  );
  check(
    'unexecuted steps do not appear ([s5] is absent from the failed run; steps present == steps attempted)',
    titles1.length === 4 && !titles1.some((t) => t.startsWith('[s5]')),
    JSON.stringify(titles1),
  );
  const badId = failingStepId(result1);
  check('failure attribution: outermost errored test.step is s4', badId === 's4', `got ${badId}`);

  // 2. Text surgery: {step_id: s4, locator} -> source edit. Then rerun.
  const specPath = join(CONSUMER, 'user-can-sign-in.spec.ts');
  const patch = patchLocatorSlot(
    readFileSync(specPath, 'utf8'), 's4',
    "page.getByRole('button', { name: 'Sign in' })",
  );
  check('the patch applies (unique anchor, one slot, one line)', patch.ok, patch.message ?? `line ${patch.line}`);
  if (patch.ok) {
    writeFileSync(specPath, patch.source);
    const relint = lintSpec(patch.source);
    check('the patched spec still passes the spec lint', relint.ok, relint.problems?.join(' | '));
    const run2 = await runPlaywright();
    const passed = readResults();
    writeFileSync(join(TRACES, 'fyr267-pass-results.json'), JSON.stringify(passed, null, 2));
    const result2 = passed.suites?.[0]?.specs?.[0]?.tests?.[0]?.results?.[0];
    check('second run passes with the healed locator', run2.status === 0 && result2?.status === 'passed', `exit=${run2.status} status=${result2?.status}`);
    check('all five step ids survive the patch (ids are never touched)', (result2?.steps ?? []).length === 5);
  }

  // 3. Refusals — a write path that only ever succeeds has not been tested.
  const dupSpec = REFUSAL_DUPLICATE.replaceAll('__PLAN_SHA__', planSha);
  writeFileSync(join(CONSUMER, 'duplicate-token.spec.ts'), dupSpec);
  const dupLint = lintSpec(dupSpec);
  check('refusal: spec lint rejects a duplicate [s2] token', !dupLint.ok && dupLint.problems.some((p) => p.includes('duplicate step token')), dupLint.problems?.join(' | '));
  const dupPatch = patchLocatorSlot(dupSpec, 's2', "page.getByLabel('Email')");
  check('refusal: the patch scan finds two anchors and refuses', !dupPatch.ok && dupPatch.reason === 'ambiguous_anchor', dupPatch.message);

  const missSpec = REFUSAL_MISSING.replaceAll('__PLAN_SHA__', planSha);
  writeFileSync(join(CONSUMER, 'missing-token.spec.ts'), missSpec);
  const missLint = lintSpec(missSpec);
  check('refusal: boundary validation rejects a step with no id token before any patch', !missLint.ok && missLint.problems.some((p) => p.includes('id token')), missLint.problems?.join(' | '));

  // Sanity: the grammar module and the patcher agree on the healed slot.
  check('the healed locator passes the slot grammar', lintLocator("getByRole('button', { name: 'Sign in' })").ok === true);
} finally {
  server.close();
}

for (const line of [...notes, ...failures]) console.log(line);
console.log(failures.length === 0
  ? '\nSPIKE PASS — the {step_id, locator} address round-trips: title token -> results.json failure attribution -> text surgery -> green rerun; refusals hold.'
  : `\nSPIKE FAIL — ${failures.length} assertion(s) failed.`);
process.exit(failures.length ? 1 : 0);
