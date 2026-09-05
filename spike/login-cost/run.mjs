// Spike: login-cost measurement (LAG-573). Zero model — no LLM, no Ollama, no MCP.
//
// Measures the trigger LAG-548 names, with stock Playwright only. Two variants
// of the same generated suite, same site, same credentials shape:
//
//   v1    : login-as-steps — every test opens with the demo plan's login
//           sequence ([s1] goto, [s2]/[s3] fill, [s4] submit) before its
//           dashboard assertions. This is the shipped v1 answer (FYR-267):
//           login is ordinary plan steps, `env:` credentials, storageState
//           banned by the spec lint.
//   setup : stock-Playwright setup project — one login in a `setup` project,
//           `page.context().storageState({ path })`, dependents run with
//           `use: { storageState }` and drop the login steps. This is the
//           piece LAG-548 would buy; the setup spec is infrastructure, not a
//           plan, and is deliberately outside the v1 grammar (it is the only
//           spec in the spike that mentions storageState).
//
// The site is a tiny cookie-session server (POST /login -> Set-Cookie,
// /dashboard requires the cookie) — a static site with client-side-only auth
// would make storageState a no-op and the comparison dishonest. Credentials
// are env-only (E2E_USER / E2E_PASSWORD) and are dummy values; the server
// accepts any non-empty pair.
//
// What is measured per run: process wall-clock, JSON-report test time, and the
// per-step durations the JSON reporter carries (login steps vs post-login
// steps). Per variant × suite size: warmup run discarded, then R timed runs;
// non-pass = exit != 0 or unexpected/flaky/skipped > 0. No retries anywhere —
// LAG-394 classification is out of scope; this only counts.
//
// Run from the repo root:  node spike/login-cost/run.mjs
//   SPIKE_SIZES=10,50   suite sizes (tests per suite)
//   SPIKE_RUNS=5        timed runs per variant × size
// Artifacts: throwaway consumer projects in spike/login-cost/consumer/ and
// numbers in spike/login-cost/results/summary.json (both gitignored — the
// results embed step timings only, never page state, but stay local anyway).

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';

import { checkPlan, lintSpec } from '../../src/plan-parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const PW_CLI = join(REPO, 'node_modules', 'playwright', 'cli.js');

const SIZES = (process.env.SPIKE_SIZES ?? '10,50').split(',').map((s) => Number(s.trim()));
const RUNS = Number(process.env.SPIKE_RUNS ?? '5');

// ------------------------------------------------------------ the plan shapes

// v1: the demo plan's login opening (s1–s4) + the two dashboard assertions.
// The setup variant keeps only the goto + assertions (login moved to the
// setup project) — ids restart at s1 because ids are per-plan, not global.
const PLAN_V1 = `profile: test
title: generated flow
file: suite
next_id: s7
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
  action: fill the password field
  locator: getByLabel('Password')
  value: env:E2E_PASSWORD
  reason: label present on the form
- id: s4
  action: submit the form
  locator: getByRole('button', { name: 'Sign in' })
  reason: role=button, name="Sign in"
- id: s5
  action: assert the dashboard heading is shown
  locator: getByRole('heading', { name: 'Dashboard' })
  expect: visible
  reason: role=heading
- id: s6
  action: assert the orders table is shown
  locator: getByRole('cell', { name: 'ORD-1043' })
  expect: visible
  reason: role=cell in the orders table
`;

const PLAN_SETUP = `profile: test
title: generated flow (post-login only)
file: suite
next_id: s4
---
## steps

- id: s1
  action: go to the dashboard
  locator: none
  value: literal '/dashboard'
- id: s2
  action: assert the dashboard heading is shown
  locator: getByRole('heading', { name: 'Dashboard' })
  expect: visible
  reason: role=heading
- id: s3
  action: assert the orders table is shown
  locator: getByRole('cell', { name: 'ORD-1043' })
  expect: visible
  reason: role=cell in the orders table
`;

// Step-id classification is per variant: in v1 the login cost is the plan's
// login opening [s1]–[s4] (the assertions are [s5]/[s6]); in the setup
// variant the only login cost is the setup project's own `[setup]` step — the
// generated tests keep [s1]-style titles for goto/asserts, which are post.
const LOGIN_IDS = {
  v1: new Set(['s1', 's2', 's3', 's4']),
  setup: new Set(),
};

const ENV_GUARDS = `const E2E_USER = process.env.E2E_USER;
if (!E2E_USER) throw new Error('missing env var E2E_USER');
const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!E2E_PASSWORD) throw new Error('missing env var E2E_PASSWORD');
`;

function testBody({ steps }) {
  return steps.map(([title, body]) => `  await test.step('${title}', async () => {
${body}
  });`).join('\n');
}

// One generated spec file: N tests sharing the plan's step shape — the stand-in
// for "N generated plans each opening with the same login sequence".
function genSpecV1(n) {
  const steps = testBody({
    steps: [
      ['[s1] go to the login page', `    await page.goto('/');`],
      ['[s2] fill the email field', `    await page.getByLabel('Email').fill(E2E_USER);`],
      ['[s3] fill the password field', `    await page.getByLabel('Password').fill(E2E_PASSWORD);`],
      ['[s4] submit the form', `    await page.getByRole('button', { name: 'Sign in' }).click();`],
      ['[s5] assert the dashboard heading is shown', `    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();`],
      ['[s6] assert the orders table is shown', `    await expect(page.getByRole('cell', { name: 'ORD-1043' })).toBeVisible();`],
    ],
  });
  const tests = Array.from({ length: n }, (_, i) => `test('generated flow ${String(i + 1).padStart(2, '0')}', async ({ page }) => {
${steps}
});`).join('\n\n');
  return { plan: PLAN_V1, spec: `// plan-sha256: __PLAN_SHA__\nimport { test, expect } from '@playwright/test';\n\n${ENV_GUARDS}\n${tests}\n` };
}

function genSpecSetup(n) {
  const steps = testBody({
    steps: [
      ['[s1] go to the dashboard', `    await page.goto('/dashboard');`],
      ['[s2] assert the dashboard heading is shown', `    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();`],
      ['[s3] assert the orders table is shown', `    await expect(page.getByRole('cell', { name: 'ORD-1043' })).toBeVisible();`],
    ],
  });
  const tests = Array.from({ length: n }, (_, i) => `test('generated flow ${String(i + 1).padStart(2, '0')}', async ({ page }) => {
${steps}
});`).join('\n\n');
  return { plan: PLAN_SETUP, spec: `// plan-sha256: __PLAN_SHA__\nimport { test, expect } from '@playwright/test';\n\n${tests}\n` };
}

// Stock-Playwright machinery — NOT a plan, NOT inside the v1 grammar. The
// storageState mention here is the piece LAG-548 would add; the spec lint
// (which bans storageState in *generated* specs) is deliberately not applied
// to this file.
const SETUP_SPEC = `import { test as setup, expect } from '@playwright/test';

${ENV_GUARDS}
setup('authenticate', async ({ page }) => {
  await setup.step('[setup] login and save storageState', async () => {
    await page.goto('/');
    await page.getByLabel('Email').fill(E2E_USER);
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.context().storageState({ path: '.auth/state.json' });
  });
});
`;

const CONFIG_V1 = `import { defineConfig } from '@playwright/test';

// Same four-part consumer config contract as the step-id roundtrip: testDir,
// baseURL from env, captureGitInfo, JSON reporter. workers: 1 — the serial
// suite is the object under measurement. retries: 0 (default) — raw runs only.
export default defineConfig({
  testDir: '.',
  testMatch: /suite\\.spec\\.ts/,
  workers: 1,
  captureGitInfo: true,
  use: { baseURL: process.env.E2E_BASE_URL, actionTimeout: 1500 },
  reporter: [['json', { outputFile: 'results.json' }]],
});
`;

const CONFIG_SETUP = `import { defineConfig } from '@playwright/test';

// The setup-project variant: same consumer contract, plus the projects graph
// LAG-548 would introduce — a 'setup' project that logs in once and saves
// storageState, and an 'e2e' project depending on it that injects the saved
// state. The generated specs under test are identical to post-login v1 steps.
export default defineConfig({
  testDir: '.',
  workers: 1,
  captureGitInfo: true,
  use: { baseURL: process.env.E2E_BASE_URL, actionTimeout: 1500 },
  reporter: [['json', { outputFile: 'results.json' }]],
  projects: [
    { name: 'setup', testMatch: /setup\\.spec\\.ts/ },
    {
      name: 'e2e',
      dependencies: ['setup'],
      testMatch: /suite\\.spec\\.ts/,
      use: { storageState: '.auth/state.json' },
    },
  ],
});
`;

// ------------------------------------------------------------ the site server

// Cookie-session auth: POST /login sets the cookie, /dashboard requires it.
// Sessions are in-memory and valueless (any non-empty credential pair logs
// in) — the point is that storageState carries a real cookie, not that the
// site is secure.
const server = createServer((req, res) => {
  const cookie = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith('sid='));
  if (req.method === 'POST' && req.url === '/login') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const form = new URLSearchParams(body);
      if (!form.get('email') || !form.get('password')) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end('<h1>Sign in</h1><p>missing credentials</p>');
        return;
      }
      res.writeHead(303, {
        'set-cookie': `sid=${crypto.randomUUID()}; Path=/; HttpOnly; SameSite=Lax`,
        location: '/dashboard',
      });
      res.end();
    });
    return;
  }
  if (req.url === '/dashboard') {
    if (!cookie) {
      res.writeHead(303, { location: '/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(readFileSync(join(HERE, 'site', 'dashboard.html')));
    return;
  }
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(readFileSync(join(HERE, 'site', 'login.html')));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

// ------------------------------------------------------------------- helpers

function runPlaywright(cwd) {
  return new Promise((resolvePromise, reject) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [PW_CLI, 'test', '--config', 'playwright.config.ts'], {
      cwd,
      env: { ...process.env, E2E_BASE_URL: BASE_URL, E2E_USER: 'spike@example.com', E2E_PASSWORD: 'correct horse', CI: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const killer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('playwright run timed out')); }, 300_000);
    child.on('error', (err) => { clearTimeout(killer); reject(err); });
    child.on('close', (exitCode) => {
      clearTimeout(killer);
      resolvePromise({ exit: exitCode, wallMs: performance.now() - t0, output: out });
    });
  });
}

// Read half: step durations out of results.json. The JSON reporter emits only
// test.step entries (proven in the step-id roundtrip), so every timed step
// here is a [sN] or [setup] token. Suites nest (project -> file -> spec), so
// the walk recurses; the generated specs have no nested steps of their own.
function readRun(cwd, variant, wallMs, exit) {
  const report = JSON.parse(readFileSync(join(cwd, 'results.json'), 'utf8'));
  let loginMs = 0;
  let postMs = 0;
  const walkSteps = (steps) => {
    for (const step of steps ?? []) {
      if (step.title.startsWith('[setup]')) loginMs += step.duration; // the one-time setup login
      else {
        const id = step.title.match(/^\[(s\d+)\]/)?.[1];
        if (LOGIN_IDS[variant].has(id)) loginMs += step.duration;
        else postMs += step.duration;
      }
      walkSteps(step.steps);
    }
  };
  const walkSuite = (suite) => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) walkSteps(test.results?.[0]?.steps);
    for (const child of suite.suites ?? []) walkSuite(child);
  };
  for (const suite of report.suites ?? []) walkSuite(suite);
  const stats = report.stats;
  const nonPass = exit !== 0 || stats.unexpected > 0 || stats.flaky > 0 || stats.skipped > 0;
  return {
    wallMs: Math.round(wallMs),
    testMs: Math.round(stats.duration),
    loginMs: Math.round(loginMs),
    postMs: Math.round(postMs),
    expected: stats.expected,
    unexpected: stats.unexpected,
    flaky: stats.flaky,
    skipped: stats.skipped,
    status: nonPass ? 'non-pass' : 'pass',
    exit,
  };
}

function project(variant, n, consumerRoot) {
  const dir = join(consumerRoot, variant);
  const { plan, spec } = variant === 'v1' ? genSpecV1(n) : genSpecSetup(n);
  const planSha = createHash('sha256').update(plan, 'utf8').digest('hex');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, '.auth'), { recursive: true });
  writeFileSync(join(dir, 'suite.plan.md'), plan);
  writeFileSync(join(dir, 'suite.spec.ts'), spec.replaceAll('__PLAN_SHA__', planSha));
  writeFileSync(join(dir, 'playwright.config.ts'), variant === 'v1' ? CONFIG_V1 : CONFIG_SETUP);
  if (variant === 'setup') writeFileSync(join(dir, 'setup.spec.ts'), SETUP_SPEC);
  return dir;
}

// ------------------------------------------------------------------- the run

let BASE_URL;
try {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  BASE_URL = `http://127.0.0.1:${server.address().port}`;

  // Grammar honesty: every generated plan parses and validates, every
  // generated spec passes the spec lint — including the storageState ban that
  // the v1 specs must not trip (only setup.spec.ts, the infrastructure spec,
  // may).
  for (const [name, plan, spec] of [
    ['v1', PLAN_V1, genSpecV1(1).spec.replaceAll('__PLAN_SHA__', createHash('sha256').update(PLAN_V1, 'utf8').digest('hex'))],
    ['setup', PLAN_SETUP, genSpecSetup(1).spec.replaceAll('__PLAN_SHA__', createHash('sha256').update(PLAN_SETUP, 'utf8').digest('hex'))],
  ]) {
    const planCheck = checkPlan(plan);
    if (!planCheck.ok) throw new Error(`plan ${name} failed parse/validation: ${planCheck.problems?.join(' | ')}`);
    const lint = lintSpec(spec);
    if (!lint.ok) throw new Error(`spec ${name} failed spec lint: ${lint.problems?.join(' | ')}`);
    if (name === 'v1' && !planCheck.envNames.includes('E2E_USER')) throw new Error('v1 plan lost its env closure');
  }
  if (lintSpec(SETUP_SPEC).ok) throw new Error('setup.spec.ts passed the generated-spec lint — it should trip the storageState ban (it is infrastructure, not a plan)');

  const consumerRoot = join(HERE, 'consumer');
  rmSync(consumerRoot, { recursive: true, force: true });
  const resultsRoot = join(HERE, 'results');
  rmSync(resultsRoot, { recursive: true, force: true });
  mkdirSync(resultsRoot, { recursive: true });

  const summary = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    playwright: JSON.parse(readFileSync(join(REPO, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8')).version,
    sizes: SIZES,
    runsPerCell: RUNS,
    cells: [],
  };

  for (const n of SIZES) {
    for (const variant of ['v1', 'setup']) {
      const dir = project(variant, n, consumerRoot);
      const runs = [];
      // Warmup (discarded): absorbs JIT/cache noise so the timed runs compare
      // like for like.
      const warm = await runPlaywright(dir);
      if (warm.exit !== 0) {
        console.error(`[warn] ${variant} n=${n} warmup exited ${warm.exit}:\n${warm.output.slice(-2000)}`);
      }
      for (let i = 0; i < RUNS; i++) {
        const r = await runPlaywright(dir);
        const data = readRun(dir, variant, r.wallMs, r.exit);
        runs.push(data);
        console.log(`[run] ${variant} n=${n} #${i + 1}: wall ${data.wallMs}ms  test ${data.testMs}ms  login ${data.loginMs}ms  post ${data.postMs}ms  ${data.status} (exit=${data.exit})`);
      }
      const nNonPass = runs.filter((r) => r.status === 'non-pass').length;
      const mean = (key) => Math.round(runs.reduce((a, r) => a + r[key], 0) / runs.length);
      const cell = {
        variant, tests: n, runs,
        meanWallMs: mean('wallMs'), meanTestMs: mean('testMs'),
        meanLoginMs: mean('loginMs'), meanPostMs: mean('postMs'),
        loginShareOfWall: +(mean('loginMs') / mean('wallMs')).toFixed(3),
        loginShareOfTest: +(mean('loginMs') / mean('testMs')).toFixed(3),
        loginPerTestMs: Math.round(mean('loginMs') / n),
        nonPassRuns: nNonPass,
      };
      summary.cells.push(cell);
      console.log(`[cell] ${variant} n=${n}: mean wall ${cell.meanWallMs}ms | mean login ${cell.meanLoginMs}ms (${(cell.loginShareOfWall * 100).toFixed(1)}% of wall, ${(cell.loginShareOfTest * 100).toFixed(1)}% of test-time, ${cell.loginPerTestMs}ms/test) | non-pass ${nNonPass}/${RUNS}`);
    }
  }

  // The comparison the trigger asks about, per size: what the setup project
  // saves (login per test × tests, minus the one-time setup login) and what
  // it costs (flakiness delta — counted, not classified).
  console.log('\n=== LAG-548 trigger comparison ===');
  for (const n of SIZES) {
    const v1 = summary.cells.find((c) => c.variant === 'v1' && c.tests === n);
    const setup = summary.cells.find((c) => c.variant === 'setup' && c.tests === n);
    console.log(`n=${n}: v1 wall ${v1.meanWallMs}ms (login ${v1.meanLoginMs}ms, ${v1.nonPassRuns}/${RUNS} non-pass) vs setup wall ${setup.meanWallMs}ms (login ${setup.meanLoginMs}ms, ${setup.nonPassRuns}/${RUNS} non-pass) -> delta ${v1.meanWallMs - setup.meanWallMs}ms wall, login ${v1.meanLoginMs - setup.meanLoginMs}ms`);
  }

  writeFileSync(join(resultsRoot, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nnumbers: spike/login-cost/results/summary.json`);
} finally {
  server.close();
}