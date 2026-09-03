// FYR-331: heal subcommand tests.
//
// Boundary + seam (FYR-325): the LLM is intercepted at the API boundary — a
// stub server on WRAPPER_OLLAMA_BASE_URL serves canned proposals, including
// deliberately malformed ones, so refusals are proven at the same seam the
// real model sits behind. The browser half runs against a real local site.
// The canned path (runHeal with rawModelResponse) exercises the classification
// and patch machinery without a browser.
//
// AC proof points: valid proposal heals; malformed proposal counts no_proposal
// (stuck vs banned classified in the .heal.md); boundary violations fail
// BEFORE the model call (zero stub requests); the envelope carries attempts +
// contract_version.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.join(ROOT, "bin", "playwright-wrapper.mjs");
const PW_VERSION = JSON.parse(
  readFileSync(path.join(ROOT, "node_modules", "@playwright", "test", "package.json"), "utf8"),
).version;

// --------------------------------------------------------------- fixtures

const HEAL_PLAN = `profile: test
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
  value: literal 'user@example.com'
- id: s3
  action: fill the password field
  locator: getByLabel('Password')
  value: literal 'correct horse'
- id: s4
  action: submit the form
  locator: getByRole('button', { name: 'Log in' })
  reason: role=button
- id: s5
  action: assert the dashboard heading is shown
  locator: getByRole('heading', { name: 'Dashboard' })
  expect: visible
  reason: role=heading
`;

// The one defect: s4 clicks 'Log in', the page's button says 'Sign in'.
const INDEX_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign in</title></head>
<body>
  <main>
    <h1>Sign in</h1>
    <form id="login">
      <label for="email">Email</label>
      <input id="email" type="email" required>
      <label for="password">Password</label>
      <input id="password" type="password" required>
      <button type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`;

// ANSI-painted failure (the probe shape the FYR-330 round-trip proved).
const WAIT_MSG =
  "\x1b[31mTimeoutError: page.click: Timeout 1500ms exceeded.\x1b[0m" +
  "\nCall log:\n  \x1b[2m- waiting for getByRole('button', { name: 'Log in' })\x1b[22m";

const STEP_TREE = [
  { title: "[s1] go to the login page", steps: [] },
  { title: "[s2] fill the email field", steps: [] },
  { title: "[s3] fill the password field", steps: [] },
  { title: "[s4] submit the form", error: { message: WAIT_MSG }, steps: [] },
];

const GOOD_PROPOSAL = `{"step_id": "s4", "locator": "getByRole('button', { name: 'Sign in' })"}`;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const CONSUMER_CONFIG = `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  workers: 1,
  use: { baseURL: process.env.E2E_BASE_URL, actionTimeout: 1500 },
  reporter: [['json', { outputFile: 'results.json' }]],
});
`;

function makeConsumerRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "fyr331-heal-"));
  t.after(() => rmNoThrow(dir));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  mkdirSync(path.join(dir, "tests"), { recursive: true });
  writeFileSync(path.join(dir, "playwright.config.ts"), CONSUMER_CONFIG);
  writeFileSync(path.join(dir, ".gitignore"), "node_modules/\nresults.json\ntest-results/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "scaffold");
  return dir;
}

function rmNoThrow(dir) {
  try {
    execFileSync("rm", ["-rf", dir]);
  } catch {
    /* best effort */
  }
}

async function generatePair(t, repo, planText = HEAL_PLAN) {
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "generate"], { cwd: repo, env: { ...process.env } });
    let stderr = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.write(planText);
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(res.code, 0, `generate failed: ${res.stderr}`);
  const specPath = path.join(repo, "tests", "user-can-sign-in.spec.ts");
  assert.ok(existsSync(specPath));
  return specPath;
}

/** A drift-valid run folder: <repo>/playwright-output/webapp/<runId>/results.json. */
function writeRun(t, repo, { reportJson, runId } = {}) {
  const sha = git(repo, "rev-parse", "HEAD");
  const id = runId ?? `2026-03-04T050607Z-${sha.slice(0, 7)}`;
  const folder = path.join(repo, "playwright-output", "webapp", id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    path.join(folder, "results.json"),
    reportJson ?? JSON.stringify(buildReport({ repo })),
  );
  return folder;
}

function buildReport({ repo, version = PW_VERSION, status = "failed", error = WAIT_MSG, steps = STEP_TREE }) {
  return {
    config: { version, rootDir: repo },
    suites: [
      {
        title: "",
        file: "",
        specs: [
          {
            title: "user can sign in",
            file: "tests/user-can-sign-in.spec.ts",
            tests: [{ results: [{ status, error: error ? { message: error } : null, errors: [], steps }] }],
          },
        ],
      },
    ],
  };
}

function spawnHeal(t, repo, args, envOverrides = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "heal", ...args], {
      cwd: repo,
      env: {
        ...process.env,
        WRAPPER_OLLAMA_API_KEY: "test-key-not-a-real-secret",
        E2E_BASE_URL: "http://127.0.0.1:59901",
        ...envOverrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Stub LLM server: one canned content string per response (or a status code
 * to force an LLM failure). Captures every request so tests can assert both
 * what reached the API boundary and what never did.
 */
async function makeStub(t, { content, status } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.method === "POST") {
        try {
          requests.push(JSON.parse(body));
        } catch {
          requests.push({ raw: body });
        }
      }
      if (status) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stub outage" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "stub",
          object: "chat.completion",
          created: 0,
          model: "stub-model",
          choices: [
            { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, count: () => requests.length };
}

async function makeSite(t) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(INDEX_HTML);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

// The injected bridge for canned-path runs (no browser): rung 1's snapshot is
// whatever this returns.
const FAKE_BRIDGE = {
  navigate: async () => {},
  snapshot: async () => `- button "Sign in" [ref=s1e5]`,
  close: async () => {},
};

const CANNED_CONFIG = { thirdTierKeyPresent: false };
const CANNED_ENV = { E2E_BASE_URL: "http://127.0.0.1:59901" };

// ------------------------------------------------------------------ units

test("parseProposal: a valid two-key proposal passes as data", async (t) => {
  const { parseProposal } = await import("../src/heal-core.mjs");
  const res = parseProposal(GOOD_PROPOSAL, { knownIds: ["s4"] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.proposal, { stepId: "s4", locator: "getByRole('button', { name: 'Sign in' })" });
});

test("parseProposal: refusals are classified, never repaired", async (t) => {
  const { parseProposal } = await import("../src/heal-core.mjs");
  const known = { knownIds: ["s1", "s4"] };
  // stuck — could not or did not answer in the contract's shape
  assert.equal(parseProposal("", known).refusal.class, "stuck");
  assert.match(parseProposal("", known).refusal.reason, /empty_response/);
  assert.equal(parseProposal("no idea, sorry", known).refusal.class, "stuck");
  assert.match(parseProposal("no idea, sorry", known).refusal.reason, /unparseable_response/);
  // Fenced JSON counts as unparseable — no fence-stripping, ever.
  const fenced = "```json\n" + GOOD_PROPOSAL + "\n```";
  assert.equal(parseProposal(fenced, known).refusal.class, "stuck");
  const nulled = `{"step_id": "s4", "locator": null}`;
  assert.equal(parseProposal(nulled, known).refusal.class, "stuck");
  assert.match(parseProposal(nulled, known).refusal.reason, /model_returned_nothing/);
  // banned — answered but violated the contract
  const unknown = `{"step_id": "s9", "locator": "getByLabel('Email')"}`;
  assert.equal(parseProposal(unknown, known).refusal.class, "banned");
  assert.match(parseProposal(unknown, known).refusal.reason, /not a step this spec carries/);
  const extra = `{"step_id": "s4", "locator": "getByLabel('Email')", "confidence": 0.9}`;
  assert.match(parseProposal(extra, known).refusal.reason, /extra_fields/);
  const engine = `{"step_id": "s4", "locator": "css=.login-button"}`;
  assert.match(parseProposal(engine, known).refusal.reason, /grammar/);
  const pageDot = `{"step_id": "s4", "locator": "page.getByRole('button', { name: 'Sign in' })"}`;
  assert.match(parseProposal(pageDot, known).refusal.reason, /grammar/);
});

test("patchLocator: one balanced splice per emission shape", async (t) => {
  const { patchLocator } = await import("../src/heal-core.mjs");
  const spec = [
    "import { test, expect } from '@playwright/test';",
    "",
    "test('user can sign in', async ({ page }) => {",
    "  await test.step('[s1] go to the login page', async () => {",
    "    await page.goto('/');",
    "  });",
    "  await test.step('[s2] fill the email field', async () => {",
    "    await page.getByLabel('Email').fill(\"user@example.com\");",
    "  });",
    "  await test.step('[s4] submit the form', async () => {",
    "    await page.getByRole('button', { name: 'Log in' }).click();",
    "  });",
    "  await test.step('[s5] assert the dashboard heading is shown', async () => {",
    "    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();",
    "  });",
    "});",
    "",
  ].join("\n");

  // click slot
  const click = patchLocator(spec, "s4", "getByRole('button', { name: 'Sign in' })");
  assert.equal(click.ok, true);
  assert.equal(click.oldLocator, "getByRole('button', { name: 'Log in' })");
  assert.equal(click.changed, true);
  assert.match(click.source, /await page\.getByRole\('button', \{ name: 'Sign in' \}\)\.click\(\);/);
  assert.ok(!click.source.includes("Log in"), "the old locator is fully replaced");

  // fill slot — the fill argument must survive untouched
  const fill = patchLocator(spec, "s2", "getByLabel('Work email')");
  assert.equal(fill.ok, true);
  assert.match(fill.source, /await page\.getByLabel\('Work email'\)\.fill\("user@example\.com"\);/);

  // expect slot
  const expect = patchLocator(spec, "s5", "getByRole('heading', { name: 'Workspace' })");
  assert.equal(expect.ok, true);
  assert.match(expect.source, /await expect\(page\.getByRole\('heading', \{ name: 'Workspace' \}\)\)\.toBeVisible\(\);/);

  // refusals
  assert.match(patchLocator(spec, "s9", "getByLabel('X')").reason, /no_anchor/);
  // The goto step carries page.goto — no locator slot to patch.
  assert.match(patchLocator(spec, "s1", "getByLabel('X')").reason, /no_slot/);
});

test("patchLocator: multi_slot refuses to guess", async (t) => {
  const { patchLocator } = await import("../src/heal-core.mjs");
  const spec = [
    "import { test, expect } from '@playwright/test';",
    "",
    "test('x', async ({ page }) => {",
    "  await test.step('[s2] fill the email field', async () => {",
    "    await page.getByLabel('Email').fill(\"user@example.com\");",
    "    await expect(page.getByLabel('Email')).toBeVisible();",
    "  });",
    "});",
    "",
  ].join("\n");
  const res = patchLocator(spec, "s2", "getByLabel('Work email')");
  assert.equal(res.ok, false);
  assert.match(res.reason, /multi_slot/);
});

// ------------------------------------------------------- canned (no browser)

async function cannedHeal(t, { reportOverrides, rawModelResponse }) {
  const { runHeal } = await import("../bin/lib/heal.mjs");
  const repo = makeConsumerRepo(t);
  const specPath = await generatePair(t, repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "pair");
  const runFolder = writeRun(t, repo, {
    reportJson: JSON.stringify(buildReport({ repo, ...reportOverrides })),
  });
  return { runHeal, repo, specPath, runFolder };
}

test("canned: a valid proposal heals — patch applied, record written, envelope shaped", async (t) => {
  const { runHeal, repo, specPath, runFolder } = await cannedHeal(t, { rawModelResponse: GOOD_PROPOSAL });
  const res = await runHeal({
    runFolder,
    cwd: repo,
    config: CANNED_CONFIG,
    env: CANNED_ENV,
    rawModelResponse: GOOD_PROPOSAL,
    bridge: FAKE_BRIDGE,
  });
  const e = res.envelope;
  assert.equal(e.contract_version, 2);
  assert.equal(e.command, "heal");
  assert.equal(e.outcome, "healed");
  assert.equal(e.outcome_class, "not_pass");
  assert.equal(e.status, "failed");
  assert.equal(e.error_stage, "run");
  assert.equal(e.failing_step, "s4");
  assert.equal(e.attempts.n_primary, 1);
  assert.equal(e.attempts.n_fallback, 0);
  assert.equal(e.attempts.third_tier.enabled, false);
  assert.equal(e.attempts.third_tier.actor, null, "the escalation router is a later ticket");
  assert.equal(e.attempts.third_tier.outcome, null);
  assert.equal(e.verified, false, "heal never claims the suite now passes");
  assert.equal(e.patch.step_id, "s4");
  assert.match(e.patch.old_locator, /Log in/);
  assert.match(e.patch.new_locator, /Sign in/);
  assert.equal(e.patch.changed, true);

  // The spec on disk carries the patched locator and still satisfies lintSpec.
  const spec = readFileSync(specPath, "utf8");
  assert.match(spec, /getByRole\('button', \{ name: 'Sign in' \}\)\.click\(\);/);
  assert.ok(!spec.includes("Log in"));

  // The record sits beside results.json and records the address + ladder.
  const record = readFileSync(e.record, "utf8");
  assert.match(record, /^outcome: healed$/m);
  assert.match(record, /^contract_version: 2$/m);
  assert.match(record, /^failing_step: s4$/m);
  assert.match(record, /^failed_locator: getByRole\('button', \{ name: 'Log in' \}\)$/m);
  assert.match(record, /^steps_attempted: s1 s2 s3 s4$/m, "unexecuted steps are absent, present = attempted");
  assert.match(record, /- rung 1: proposal s4 getByRole\('button', \{ name: 'Sign in' \}/);
  assert.match(record, /^attempts: n_primary=1 n_fallback=0$/m);
  assert.match(record, /## page state/);
  assert.match(record, /button "Sign in" \[ref=s1e5\]/, "the page snapshot the rung saw is recorded");
});

test("canned: malformed proposals count no_proposal, classified stuck vs banned", async (t) => {
  const cases = [
    ["I cannot propose a locator for this step.", /stuck: unparseable_response/],
    ["```json\n" + GOOD_PROPOSAL + "\n```", /stuck: unparseable_response/],
    [`{"step_id": "s4", "locator": null}`, /stuck: model_returned_nothing/],
    [`{"step_id": "s2", "locator": "getByLabel('Email')"}`, /banned: proposal targets s2 but the trace failed at s4/],
    [`{"step_id": "s4", "locator": "page.getByRole('button')", "confidence": 0.9}`, /banned: extra_fields/],
    [`{"step_id": "s4", "locator": "css=.submit"}`, /banned: locator rejected by the grammar/],
  ];
  const { runHeal } = await import("../bin/lib/heal.mjs");
  for (const [raw, expected] of cases) {
    const { repo, specPath, runFolder } = await cannedHeal(t, {});
    const res = await runHeal({
      runFolder,
      cwd: repo,
      config: CANNED_CONFIG,
      env: CANNED_ENV,
      rawModelResponse: raw,
      bridge: FAKE_BRIDGE,
    });
    assert.equal(res.envelope.outcome, "no_proposal", `case ${raw.slice(0, 40)}`);
    assert.equal(res.envelope.attempts.n_primary, 1);
    const record = readFileSync(res.envelope.record, "utf8");
    assert.match(record, /^outcome: no_proposal$/m);
    assert.match(record, expected, `case ${raw.slice(0, 40)}`);
    // The spec is never patched by a refused proposal.
    assert.ok(readFileSync(specPath, "utf8").includes("Log in"), `spec untouched for ${raw.slice(0, 40)}`);
  }
});

test("canned: the envelope carries third-tier key presence (FYR-257), value never read", async (t) => {
  const { runHeal, repo, runFolder } = await cannedHeal(t, { rawModelResponse: GOOD_PROPOSAL });
  const res = await runHeal({
    runFolder,
    cwd: repo,
    config: { thirdTierKeyPresent: true },
    env: CANNED_ENV,
    rawModelResponse: GOOD_PROPOSAL,
    bridge: FAKE_BRIDGE,
  });
  assert.equal(res.envelope.attempts.third_tier.enabled, true);
  assert.equal(res.envelope.attempts.third_tier.actor, null);
});

test("canned: a passed run is nothing_to_heal — no record written", async (t) => {
  const { runHeal, repo, runFolder } = await cannedHeal(t, {
    reportOverrides: { status: "passed", error: null },
  });
  const res = await runHeal({
    runFolder, cwd: repo, config: CANNED_CONFIG, env: CANNED_ENV, rawModelResponse: "", bridge: FAKE_BRIDGE,
  });
  assert.equal(res.envelope.outcome, "nothing_to_heal");
  assert.equal(res.envelope.outcome_class, "pass");
  assert.equal(res.envelope.attempts.n_primary, 0, "no rung entered");
  assert.equal(res.envelope.record, null);
  assert.ok(!existsSync(path.join(runFolder, "user-can-sign-in.heal.md")), "no record for a passing run");
});

test("canned: no_verdict never enters the loop (FYR-250)", async (t) => {
  const { runHeal, repo, runFolder } = await cannedHeal(t, {
    reportOverrides: { status: "skipped", error: null },
  });
  await assert.rejects(
    runHeal({ runFolder, cwd: repo, config: CANNED_CONFIG, env: CANNED_ENV, bridge: FAKE_BRIDGE }),
    /no_verdict never enters the heal loop/,
  );
});

test("canned: a compile-stage trace is refused — the ladder addresses run/assert only", async (t) => {
  const { runHeal, repo, runFolder } = await cannedHeal(t, {
    reportOverrides: { steps: [], error: "Error: Cannot find module './missing'" },
  });
  await assert.rejects(
    runHeal({ runFolder, cwd: repo, config: CANNED_CONFIG, env: CANNED_ENV, bridge: FAKE_BRIDGE }),
    /compile-stage failure/,
  );
});

test("canned: a version-mismatched report is refused before any patch (FYR-249)", async (t) => {
  const { runHeal, repo, runFolder } = await cannedHeal(t, {
    reportOverrides: { version: "99.0.0" },
  });
  await assert.rejects(
    runHeal({ runFolder, cwd: repo, config: CANNED_CONFIG, env: CANNED_ENV, bridge: FAKE_BRIDGE }),
    /version mismatch/,
  );
});

test("canned: a failed run the trace cannot address is refused loudly", async (t) => {
  const { runHeal, repo, runFolder } = await cannedHeal(t, {
    reportOverrides: { error: null, steps: [{ title: "[s1] go to the login page", steps: [] }] },
  });
  await assert.rejects(
    runHeal({ runFolder, cwd: repo, config: CANNED_CONFIG, env: CANNED_ENV, bridge: FAKE_BRIDGE }),
    /names no failing \[sN\] step/,
  );
});

// --------------------------------------------- E2E: bin + stub LLM + real site

test("bin E2E: a stub-served valid proposal heals the run end-to-end", async (t) => {
  const site = await makeSite(t);
  const stub = await makeStub(t, { content: GOOD_PROPOSAL });
  const repo = makeConsumerRepo(t);
  const specPath = await generatePair(t, repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "pair");
  const runFolder = writeRun(t, repo);
  const origSpec = readFileSync(specPath, "utf8");

  const { code, stdout, stderr } = await spawnHeal(t, repo, [runFolder], {
    WRAPPER_OLLAMA_BASE_URL: stub.url,
    E2E_BASE_URL: site,
  });
  assert.equal(code, 0, `heal exits 0 (stderr: ${stderr})`);
  const e = JSON.parse(stdout);
  assert.equal(e.outcome, "healed");
  assert.equal(e.contract_version, 2);
  assert.equal(e.attempts.n_primary, 1);
  assert.equal(e.attempts.n_fallback, 0);
  assert.equal(e.verified, false);
  assert.match(e.patch.old_locator, /Log in/);
  assert.match(e.patch.new_locator, /Sign in/);
  assert.ok(existsSync(e.record));

  // The stub received exactly the rung-1 turn: failing step facts + snapshot.
  assert.equal(stub.count(), 1, "one primary call, no fallback");
  const messages = stub.requests[0].messages;
  const userTurn = messages.find((m) => m.role === "user").content;
  assert.match(userTurn, /FAILING STEP/);
  assert.match(userTurn, /id: s4/);
  assert.match(userTurn, /getByRole\('button', \{ name: 'Log in' \}\)/, "the failed locator from the plan");
  assert.match(userTurn, /button "Sign in" \[ref=e\d+\]/, "the live page snapshot");

  const spec = readFileSync(specPath, "utf8");
  assert.match(spec, /name: 'Sign in' \}\)\.click\(\);/);
  assert.ok(!spec.includes("Log in"));
  // The record's page-state section is the REAL fresh snapshot from the site.
  const record = readFileSync(e.record, "utf8");
  assert.match(record, /^outcome: healed$/m);
  assert.match(record, /button "Sign in"/);
  // Patched spec still parses (the compile safety net ran against it).
  const check = execFileSync(process.execPath, ["--experimental-strip-types", "--check", specPath], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(check !== undefined);
});

test("bin E2E: a malformed stub response counts no_proposal; spec untouched", async (t) => {
  const site = await makeSite(t);
  const stub = await makeStub(t, { content: "I cannot identify a locator for this step." });
  const repo = makeConsumerRepo(t);
  const specPath = await generatePair(t, repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "pair");
  const runFolder = writeRun(t, repo);

  const { code, stdout } = await spawnHeal(t, repo, [runFolder], {
    WRAPPER_OLLAMA_BASE_URL: stub.url,
    E2E_BASE_URL: site,
  });
  assert.equal(code, 1, "no_proposal exits 1");
  const e = JSON.parse(stdout);
  assert.equal(e.outcome, "no_proposal");
  assert.equal(e.attempts.n_primary, 1);
  assert.equal(e.attempts.n_fallback, 0);
  assert.equal(e.patch, null);
  const record = readFileSync(e.record, "utf8");
  assert.match(record, /no_proposal — stuck: unparseable_response/);
  assert.ok(readFileSync(specPath, "utf8").includes("Log in"), "spec untouched");
});

test("bin E2E: both LLM tiers failing records stuck/llm_failed with n_fallback=1", async (t) => {
  const site = await makeSite(t);
  const stub = await makeStub(t, { status: 500 });
  const repo = makeConsumerRepo(t);
  await generatePair(t, repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "pair");
  const runFolder = writeRun(t, repo);

  const { code, stdout } = await spawnHeal(t, repo, [runFolder], {
    WRAPPER_OLLAMA_BASE_URL: stub.url,
    E2E_BASE_URL: site,
  });
  assert.equal(code, 1);
  const e = JSON.parse(stdout);
  assert.equal(e.outcome, "no_proposal");
  assert.equal(e.attempts.n_primary, 1);
  assert.equal(e.attempts.n_fallback, 1, "the fallback was engaged exactly once on failure");
  const record = readFileSync(e.record, "utf8");
  assert.match(record, /stuck: llm_failed/);
  // 2 main attempts (transient retry) + 1 fallback = 3 requests at the seam.
  assert.equal(stub.count(), 3);
});

test("bin E2E: drift refusal exits 1 with ZERO model calls and never names the bypass", async (t) => {
  const stub = await makeStub(t, { content: GOOD_PROPOSAL });
  const repo = makeConsumerRepo(t);
  await generatePair(t, repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "pair");
  const runFolder = writeRun(t, repo, { runId: "2026-03-04T050607Z-deadbee" });

  const { code, stdout, stderr } = await spawnHeal(t, repo, [runFolder], {
    WRAPPER_OLLAMA_BASE_URL: stub.url,
  });
  assert.equal(code, 1);
  assert.match(stderr, /refusing to heal: this run's commit deadbee does not match/);
  assert.ok(!/drift-ok/.test(stderr), "the refusal never names its bypass flag");
  assert.equal(stub.count(), 0, "no model call happened — boundary validation first");
  assert.ok(!/outcome/.test(stdout), "no envelope on a refused run");
});

test("bin E2E: --drift-ok=<report sha> is value-bearing and proceeds to the ladder", async (t) => {
  const site = await makeSite(t);
  const stub = await makeStub(t, { content: GOOD_PROPOSAL });
  const repo = makeConsumerRepo(t);
  await generatePair(t, repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "pair");
  const runFolder = writeRun(t, repo, { runId: "2026-03-04T050607Z-deadbee" });

  const { code, stdout, stderr } = await spawnHeal(
    t,
    repo,
    [runFolder, "--drift-ok=deadbee"],
    { WRAPPER_OLLAMA_BASE_URL: stub.url, E2E_BASE_URL: site },
  );
  assert.equal(code, 0, `override proceeds (stderr: ${stderr})`);
  assert.equal(JSON.parse(stdout).outcome, "healed");
  assert.ok(stub.count() >= 1, "the model call happened under the override");
});

test("bin: missing run-folder argument exits 2 with usage", async () => {
  const { code, stderr } = await spawnHeal(null, ROOT, []);
  assert.equal(code, 2);
  assert.match(stderr, /Usage: playwright-wrapper heal <run-folder>/);
});

test("bin: a run folder without results.json exits 2 (self-locating contract)", async (t) => {
  const repo = makeConsumerRepo(t);
  const empty = path.join(repo, "playwright-output", "webapp", "2026-03-04T050607Z-deadbee");
  mkdirSync(empty, { recursive: true });
  const { code, stderr } = await spawnHeal(t, repo, [empty]);
  assert.equal(code, 2);
  assert.match(stderr, /results\.json is not inside/);
});