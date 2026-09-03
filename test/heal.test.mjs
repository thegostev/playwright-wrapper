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
        OPENAI_API_KEY: "", // the tier stays off unless a test enables it
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

test("routeEscalation: the FYR-257 test-profile table, pure per-reason", async (t) => {
  const { routeEscalation } = await import("../src/heal-core.mjs");
  // budget/fallback → Retry(third_tier) iff enabled, else Terminal(prompt)
  assert.deepEqual(routeEscalation({ reason: "budget_exhausted", thirdTierEnabled: true }), { retryThirdTier: true, disposition: null });
  assert.deepEqual(routeEscalation({ reason: "fallback_exhausted", thirdTierEnabled: true }), { retryThirdTier: true, disposition: null });
  assert.deepEqual(routeEscalation({ reason: "budget_exhausted", thirdTierEnabled: false }), { retryThirdTier: false, disposition: "prompt" });
  assert.deepEqual(routeEscalation({ reason: "fallback_exhausted", thirdTierEnabled: false }), { retryThirdTier: false, disposition: "prompt" });
  // infra → Terminal(prompt) even with the tier enabled: capability valve, not failover
  assert.deepEqual(routeEscalation({ reason: "infra", thirdTierEnabled: true }), { retryThirdTier: false, disposition: "prompt" });
  // non_retryable in test v1 → loud-fatal null (Q3) — never a silent default
  assert.equal(routeEscalation({ reason: "non_retryable", thirdTierEnabled: true }).disposition, null);
  assert.equal(routeEscalation({ reason: "non_retryable", thirdTierEnabled: true }).fatal, true);
  // unknown reasons are loud-fatal too: fallback-not-classification
  assert.equal(routeEscalation({ reason: "mystery", thirdTierEnabled: true }).fatal, true);
  // the reason itself is loop-state, never outcome-derived (FYR-250)
  const { deriveEscalationReason } = await import("../src/heal-core.mjs");
  assert.equal(deriveEscalationReason({ fallbackEngaged: false }), "budget_exhausted");
  assert.equal(deriveEscalationReason({ fallbackEngaged: true }), "fallback_exhausted");
  // the 294 invariant, stated as code
  const { expectedHistoryLength } = await import("../src/heal-core.mjs");
  const A = { total: 3 };
  assert.equal(expectedHistoryLength(A, "no_proposal"), 2, "the no-run deficit subtracts the shot");
  assert.equal(expectedHistoryLength(A, "errored"), 2);
  assert.equal(expectedHistoryLength(A, "failed"), 3, "a real attempt is a history entry");
  assert.equal(expectedHistoryLength(A, "healed"), 3);
  assert.equal(expectedHistoryLength(A, null), 3, "count 0 subtracts nothing");
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
  assert.equal(e.attempts.total, 1);
  assert.equal(e.attempts.third_tier, 0, "the tier never ran — rung 1 healed");
  assert.equal(e.third_tier.enabled, false);
  assert.equal(e.third_tier.actor, null);
  assert.equal(e.third_tier.outcome, null);
  assert.equal(e.escalation, null, "success → no escalation event (FYR-294)");
  assert.equal(e.outcome_history.length, 1);
  assert.equal(e.outcome_history[0].actor, "primary");
  assert.equal(e.outcome_history[0].outcome, "healed");
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
  assert.match(record, /^attempts: n_primary=1 n_fallback=0 third_tier=0$/m);
  assert.ok(!record.includes("## escalation"), "no escalation section on a healed run");
  assert.ok(!record.includes("## third tier"), "no third-tier section when it never ran");
  assert.match(record, /## page state/);
  assert.match(record, /button "Sign in" \[ref=s1e5\]/, "the page snapshot the rung saw is recorded");
});

test("canned: malformed proposals climb to rung 2, then count no_proposal (stuck vs banned in the record)", async (t) => {
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
      interactive: true, // a developer is watching this run
    });
    assert.equal(res.envelope.outcome, "no_proposal", `case ${raw.slice(0, 40)}`);
    assert.equal(res.envelope.attempts.n_primary, 2, "the ladder climbed to rung 2 (input differs)");
    assert.equal(res.envelope.attempts.total, 2);
    // The exhaustion terminal: one escalation event, original reason.
    assert.equal(res.envelope.escalation.reason, "budget_exhausted", `case ${raw.slice(0, 40)}`);
    assert.equal(res.envelope.escalation.disposition, "prompt");
    assert.equal(res.envelope.escalation.profile, "test");
    assert.equal(res.envelope.third_tier.enabled, false, "no key → no tier, ever");
    assert.equal(res.envelope.attempts.third_tier, 0);
    assert.equal(res.envelope.outcome_history.length, 2);
    const record = readFileSync(res.envelope.record, "utf8");
    assert.match(record, /^outcome: no_proposal$/m);
    assert.match(record, /^reason: budget_exhausted$/m);
    assert.match(record, /^disposition: prompt$/m);
    assert.match(record, /^- rung 1: no_proposal/m);
    assert.match(record, /^- rung 2: no_proposal/m, "rung 2 ran with why-failed context");
    assert.match(record, expected, `case ${raw.slice(0, 40)}`);
    // The spec is never patched by a refused proposal.
    assert.ok(readFileSync(specPath, "utf8").includes("Log in"), `spec untouched for ${raw.slice(0, 40)}`);
  }
});

test("canned: rung 2 carries the why-failed context and heals where rung 1 refused", async (t) => {
  const { runHeal, repo, specPath, runFolder } = await cannedHeal(t, {});
  const res = await runHeal({
    runFolder, cwd: repo, config: CANNED_CONFIG, env: CANNED_ENV,
    rawModelResponse: "no idea, sorry", // rung 1: refused (stuck)
    rawModelResponse2: GOOD_PROPOSAL,   // rung 2: heals
    bridge: FAKE_BRIDGE,
  });
  const e = res.envelope;
  assert.equal(e.outcome, "healed");
  assert.equal(e.attempts.n_primary, 2, "both rungs ran");
  assert.equal(e.attempts.total, 2);
  assert.equal(e.escalation, null, "healed mid-ladder → no escalation event");
  assert.equal(e.outcome_history.length, 2);
  assert.equal(e.outcome_history[0].actor, "primary");
  assert.equal(e.outcome_history[0].outcome, "no_proposal");
  assert.equal(e.outcome_history[1].actor, "primary");
  assert.equal(e.outcome_history[1].outcome, "healed");
  const record = readFileSync(e.record, "utf8");
  assert.match(record, /^- rung 1: no_proposal/m);
  assert.match(record, /^- rung 2: proposal s4 getByRole\('button', \{ name: 'Sign in' \}/m);
  const spec = readFileSync(specPath, "utf8");
  assert.match(spec, /name: 'Sign in' \}\)\.click\(\);/);
  assert.ok(!spec.includes("Log in"));
});

test("canned: the envelope carries third-tier key presence (FYR-257), value never read", async (t) => {
  const { runHeal, repo, runFolder } = await cannedHeal(t, { rawModelResponse: GOOD_PROPOSAL });
  const res = await runHeal({
    runFolder,
    cwd: repo,
    config: { thirdTierKeyPresent: true, thirdTierModel: "gpt-5.6-sol" },
    env: CANNED_ENV,
    rawModelResponse: GOOD_PROPOSAL,
    bridge: FAKE_BRIDGE,
  });
  assert.equal(res.envelope.third_tier.enabled, true, "key present → enabled at emit");
  assert.equal(res.envelope.attempts.third_tier, 0, "run healed on rung 1 — the tier was never invoked");
  assert.equal(res.envelope.third_tier.actor, null, "count 0 ⇒ actor null (FYR-294 presence rule)");
  assert.equal(res.envelope.third_tier.outcome, null);
});

// ------------------------------------------------ FYR-332: exhaustion + tier

const TIER_CONFIG = { thirdTierKeyPresent: true, thirdTierModel: "gpt-5.6-sol-stub" };

test("canned: exhaustion with the key present fires the tier ONCE and heals — no escalation event", async (t) => {
  const { runHeal, repo, specPath, runFolder } = await cannedHeal(t, {});
  const res = await runHeal({
    runFolder, cwd: repo, config: TIER_CONFIG, env: CANNED_ENV,
    rawModelResponse: "no idea, sorry",  // rung 1 refused
    rawModelResponse2: "still nothing",  // rung 2 refused
    rawThirdTierResponse: GOOD_PROPOSAL, // the tier heals
    bridge: FAKE_BRIDGE,
  });
  const e = res.envelope;
  assert.equal(e.outcome, "healed");
  assert.equal(e.escalation, null, "tier success → NO escalation event (FYR-294)");
  assert.equal(e.attempts.n_primary, 2);
  assert.equal(e.attempts.n_fallback, 0);
  assert.equal(e.attempts.third_tier, 1);
  assert.equal(e.attempts.total, 3);
  assert.deepEqual(
    { enabled: e.third_tier.enabled, actor: e.third_tier.actor, outcome: e.third_tier.outcome },
    { enabled: true, actor: "gpt-5.6-sol-stub", outcome: "healed" },
  );
  assert.equal(e.outcome_history.length, 3);
  assert.equal(e.outcome_history[2].actor, "third_tier");
  assert.equal(e.outcome_history[2].outcome, "healed");
  assert.equal(e.patch.step_id, "s4");
  assert.match(readFileSync(specPath, "utf8"), /name: 'Sign in' \}\)\.click\(\);/);
  const record = readFileSync(e.record, "utf8");
  assert.match(record, /^## third tier$/m);
  assert.match(record, /^actor: gpt-5.6-sol-stub$/m);
  assert.match(record, /^proposal: s4 getByRole\('button', \{ name: 'Sign in' \}\)$/m);
  assert.ok(!/## escalation/.test(record), "no escalation section when the tier healed");
});

test("canned: the rich-context tier turn includes the failed proposals (FYR-294)", async (t) => {
  const { buildThirdTierTurn } = await import("../src/heal-core.mjs");
  const turn = buildThirdTierTurn(
    { id: "s4", action: "submit the form", locator: "getByRole('button', { name: 'Log in' })", stage: "run", errorMessage: "TimeoutError" },
    `- button "Sign in" [ref=e5]`,
    "attempt 1 answered but the proposal was refused (banned: locator rejected by the grammar: engine prefix)",
    [{ actor: "primary", stepId: "s4", locator: "css=.submit", verdict: "banned: locator rejected by the grammar" }],
  );
  assert.match(turn, /FAILING STEP/);
  assert.match(turn, /id: s4/);
  assert.match(turn, /WHY THE PREVIOUS ATTEMPTS FAILED/);
  assert.match(turn, /THE FAILED PROPOSALS THE PREVIOUS MODELS MADE/);
  assert.match(turn, /\[primary\] proposed s4 css=\.submit/);
  assert.match(turn, /- button "Sign in" \[ref=e5\]/, "the snapshot is in the tier's input");
});

test("canned: tier returns nothing → no_proposal with the history deficit; original reason stands", async (t) => {
  const { runHeal, repo, runFolder } = await cannedHeal(t, {});
  const res = await runHeal({
    runFolder, cwd: repo, config: TIER_CONFIG, env: CANNED_ENV,
    rawModelResponse: "no idea, sorry",
    rawThirdTierResponse: "I cannot identify a locator for this step.", // stuck
    bridge: FAKE_BRIDGE,
    interactive: true,
  });
  const e = res.envelope;
  assert.equal(e.outcome, "no_proposal");
  assert.equal(e.third_tier.outcome, "no_proposal", "a stuck refusal is the tier's no_proposal (294)");
  assert.equal(e.third_tier.actor, "gpt-5.6-sol-stub");
  assert.equal(e.attempts.third_tier, 1);
  assert.equal(e.attempts.total, 3);
  // One-shot guard: the terminal carries the ORIGINAL reason, not a new one.
  assert.equal(e.escalation.reason, "budget_exhausted");
  assert.equal(e.escalation.disposition, "prompt");
  // History deficit: the tier was invoked but produced no usable run.
  assert.equal(e.outcome_history.length, 2, "attempts.total 3 minus the no-run deficit");
  const record = readFileSync(e.record, "utf8");
  assert.match(record, /^## third tier$/m);
  assert.match(record, /^outcome: no_proposal$/m);
  assert.match(record, /^refusal: stuck: unparseable_response/m);
  assert.match(record, /^reason: budget_exhausted$/m);
});

test("canned: tier answered out-of-contract → outcome failed, history entry present", async (t) => {
  const { runHeal, repo, specPath, runFolder } = await cannedHeal(t, {});
  const res = await runHeal({
    runFolder, cwd: repo, config: TIER_CONFIG, env: CANNED_ENV,
    rawModelResponse: "no idea, sorry",
    rawThirdTierResponse: `{"step_id": "s4", "locator": "css=.submit"}`, // answered, banned
    bridge: FAKE_BRIDGE,
  });
  assert.equal(res.envelope.third_tier.outcome, "failed", "answered → the tier's failed");
  assert.equal(res.envelope.outcome, "no_proposal");
  assert.equal(res.envelope.escalation.reason, "budget_exhausted", "the original reason stands — no new reason");
  assert.equal(res.envelope.outcome_history.length, 3, "a failed tier attempt is a real attempt");
  assert.equal(res.envelope.outcome_history[2].outcome, "failed");
  assert.ok(readFileSync(specPath, "utf8").includes("Log in"), "a banned tier proposal never patches");
});

test("canned: tier call dies → outcome errored with the deficit; one-shot guard holds", async (t) => {
  const { runHeal, repo, runFolder } = await cannedHeal(t, {});
  const res = await runHeal({
    runFolder, cwd: repo, config: TIER_CONFIG, env: CANNED_ENV,
    rawModelResponse: "no idea, sorry",
    rawThirdTierResponse: null, // the call fails
    bridge: FAKE_BRIDGE,
  });
  assert.equal(res.envelope.third_tier.outcome, "errored");
  assert.equal(res.envelope.attempts.third_tier, 1);
  assert.equal(res.envelope.escalation.reason, "budget_exhausted", "no new reason, no router re-consult");
  assert.equal(res.envelope.outcome_history.length, 2, "the errored shot never ran a Playwright attempt");
  const record = readFileSync(res.envelope.record, "utf8");
  assert.match(record, /^outcome: errored$/m);
  assert.match(record, /^call failed: /m);
});

test("canned: tier proposes for the wrong step → banned → failed", async (t) => {
  const { runHeal, repo, runFolder } = await cannedHeal(t, {});
  const res = await runHeal({
    runFolder, cwd: repo, config: TIER_CONFIG, env: CANNED_ENV,
    rawModelResponse: "no idea, sorry",
    rawThirdTierResponse: `{"step_id": "s2", "locator": "getByLabel('Email')"}`,
    bridge: FAKE_BRIDGE,
    interactive: true,
  });
  assert.equal(res.envelope.third_tier.outcome, "failed");
  const record = readFileSync(res.envelope.record, "utf8");
  assert.match(record, /^refusal: banned: proposal targets s2 but the trace failed at s4/m);
  assert.equal(res.envelope.escalation.reason, "budget_exhausted");
});

test("canned: no-key exhaustion lands on the terminal prompt with zero tier machinery (AC 5)", async (t) => {
  const { runHeal, repo, runFolder } = await cannedHeal(t, {});
  const res = await runHeal({
    runFolder, cwd: repo, config: CANNED_CONFIG, env: CANNED_ENV,
    rawModelResponse: "no idea, sorry", bridge: FAKE_BRIDGE, interactive: true,
  });
  assert.equal(res.envelope.third_tier.enabled, false);
  assert.equal(res.envelope.attempts.third_tier, 0);
  assert.equal(res.envelope.escalation.reason, "budget_exhausted");
  assert.equal(res.envelope.escalation.disposition, "prompt");
});

test("canned: a machine-consumed run downgrades prompt → defer (loop-derived, 257 Q5)", async (t) => {
  const { runHeal, repo, runFolder } = await cannedHeal(t, {});
  const res = await runHeal({
    runFolder, cwd: repo, config: CANNED_CONFIG, env: CANNED_ENV,
    rawModelResponse: "no idea, sorry", bridge: FAKE_BRIDGE, interactive: false,
  });
  assert.equal(res.envelope.escalation.disposition, "defer");
});

test("canned: browser bridge failure → reason infra, no rung ran, no tier (capability valve)", async (t) => {
  const { runHeal, repo, runFolder } = await cannedHeal(t, {});
  const deadBridge = { navigate: async () => { throw new Error("chromium is gone"); }, snapshot: async () => "", close: async () => {} };
  const res = await runHeal({
    runFolder, cwd: repo, config: TIER_CONFIG, env: CANNED_ENV,
    rawModelResponse: GOOD_PROPOSAL, bridge: deadBridge, interactive: true,
  });
  const e = res.envelope;
  assert.equal(e.outcome, "no_proposal");
  assert.equal(e.escalation.reason, "infra");
  assert.equal(e.escalation.disposition, "prompt", "infra → Terminal(prompt): no third-tier failover in v1");
  assert.equal(e.attempts.total, 0, "no rung ran");
  assert.equal(e.attempts.n_primary, 0);
  assert.equal(e.attempts.third_tier, 0, "the tier is a capability valve, not availability failover");
  assert.deepEqual(e.outcome_history, [], "empty history iff attempts.total == 0 (FYR-250)");
  const record = readFileSync(e.record, "utf8");
  assert.match(record, /\(no rung entered\)/);
  assert.match(record, /^reason: infra$/m);
  assert.ok(!/## third tier/.test(record), "the tier never fired for an infra reason");
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

test("bin E2E: a malformed stub response climbs to rung 2 then counts no_proposal; spec untouched", async (t) => {
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
  assert.equal(e.attempts.n_primary, 2, "the ladder climbed to rung 2");
  assert.equal(e.attempts.n_fallback, 0);
  assert.equal(e.attempts.third_tier, 0, "no key → the tier never ran");
  assert.equal(e.patch, null);
  assert.equal(e.escalation.reason, "budget_exhausted");
  assert.equal(e.escalation.disposition, "defer", "spawned stdio is not a TTY → the loop downgrades to defer");
  const record = readFileSync(e.record, "utf8");
  assert.match(record, /no_proposal — stuck: unparseable_response/);
  assert.match(record, /^reason: budget_exhausted$/m);
  // Rung 2's turn carries the why-failed context (the input-differs rule).
  assert.equal(stub.count(), 2, "one request per rung, no more");
  const rung2 = stub.requests[1].messages.find((m) => m.role === "user").content;
  assert.match(rung2, /WHY THE PREVIOUS ATTEMPT FAILED/);
  assert.match(rung2, /attempt 1 answered but the proposal was refused/);
  assert.ok(readFileSync(specPath, "utf8").includes("Log in"), "spec untouched");
});

test("bin E2E: both LLM tiers failing on both rungs → fallback_exhausted, defer, no tier", async (t) => {
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
  assert.equal(e.attempts.n_primary, 2, "both rungs attempted the main model");
  assert.equal(e.attempts.n_fallback, 2, "the fallback was engaged on every failed rung");
  assert.equal(e.attempts.total, 4);
  assert.equal(e.third_tier.enabled, false, "no OPENAI key → tier off");
  assert.equal(e.escalation.reason, "fallback_exhausted", "the fallback was attempted and also failed (FYR-250)");
  assert.equal(e.escalation.disposition, "defer");
  assert.equal(e.outcome_history.length, 4);
  const record = readFileSync(e.record, "utf8");
  assert.match(record, /stuck: llm_failed/);
  assert.match(record, /^reason: fallback_exhausted$/m);
  // 2 rungs × (2 main attempts w/ transient retry + 1 fallback) = 6 requests.
  assert.equal(stub.count(), 6);
});

// ------------------------------------------- E2E: the third tier at the seam

/**
 * A stub OpenAI-compatible server for the third tier: one canned content
 * (or a status to force an error). Captures requests so tests can assert
 * what the tier saw and that it was called exactly once.
 */
async function makeTierStub(t, { content, status, model = "stub-openai-model" } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.method === "POST") {
        try { requests.push(JSON.parse(body)); } catch { requests.push({ raw: body }); }
      }
      if (status) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "tier outage" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "tier-stub", object: "chat.completion", created: 0, model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { total_tokens: 20 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, count: () => requests.length };
}

const EXHAUSTED_ENV = { OPENAI_API_KEY: "sk-third-tier-test-only" };

test("bin E2E: exhaustion + key → one rich-context GPT-5.6 shot heals; no escalation event", async (t) => {
  const site = await makeSite(t);
  const stub = await makeStub(t, { content: "I cannot identify a locator for this step." });
  const tier = await makeTierStub(t, { content: GOOD_PROPOSAL });
  const repo = makeConsumerRepo(t);
  const specPath = await generatePair(t, repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "pair");
  const runFolder = writeRun(t, repo);

  const { code, stdout, stderr } = await spawnHeal(t, repo, [runFolder], {
    WRAPPER_OLLAMA_BASE_URL: stub.url,
    WRAPPER_OPENAI_BASE_URL: tier.url,
    ...EXHAUSTED_ENV,
    E2E_BASE_URL: site,
  });
  assert.equal(code, 0, `healed via the tier (stderr: ${stderr})`);
  const e = JSON.parse(stdout);
  assert.equal(e.outcome, "healed");
  assert.equal(e.escalation, null, "tier success → no escalation event");
  assert.equal(e.third_tier.enabled, true);
  assert.equal(e.third_tier.actor, "stub-openai-model", "the actor is what answered");
  assert.equal(e.third_tier.outcome, "healed");
  assert.equal(e.attempts.third_tier, 1);
  assert.equal(e.outcome_history.length, 3);
  assert.equal(e.outcome_history[2].actor, "third_tier");

  // Exactly ONE tier request, at the third-tier seam, with the tier's contract:
  // ~512-token cap, max reasoning effort, the OPENAI key (not the Ollama key).
  assert.equal(tier.count(), 1, "one GPT-5.6 attempt — the one-shot budget");
  const req = tier.requests[0];
  assert.equal(req.max_tokens, 512);
  assert.equal(req.reasoning_effort, "max");
  assert.equal(req.model, "gpt-5.6-sol", "the confirmed FYR-257 actor id");
  const userTurn = req.messages.find((m) => m.role === "user").content;
  assert.match(userTurn, /WHY THE PREVIOUS ATTEMPTS FAILED/);
  assert.match(userTurn, /THE FAILED PROPOSALS THE PREVIOUS MODELS MADE/);
  assert.match(userTurn, /button "Sign in" \[ref=e\d+\]/, "the live snapshot is in the tier's input");
  // The Ollama stub saw both rungs; the tier stub saw one call.
  assert.equal(stub.count(), 2);
  const spec = readFileSync(specPath, "utf8");
  assert.match(spec, /name: 'Sign in' \}\)\.click\(\);/);
  assert.ok(!spec.includes("Log in"));
});

test("bin E2E: exhaustion without a key → zero third-tier requests, defer disposition (AC 5)", async (t) => {
  const site = await makeSite(t);
  const stub = await makeStub(t, { content: "no idea, sorry" });
  const tier = await makeTierStub(t, { content: GOOD_PROPOSAL });
  const repo = makeConsumerRepo(t);
  await generatePair(t, repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "pair");
  const runFolder = writeRun(t, repo);

  const { code, stdout } = await spawnHeal(t, repo, [runFolder], {
    WRAPPER_OLLAMA_BASE_URL: stub.url,
    WRAPPER_OPENAI_BASE_URL: tier.url, // reachable on purpose — must never be hit
    E2E_BASE_URL: site,
  });
  assert.equal(code, 1);
  const e = JSON.parse(stdout);
  assert.equal(e.outcome, "no_proposal");
  assert.equal(e.third_tier.enabled, false, "no key → tier disabled at emit");
  assert.equal(e.attempts.third_tier, 0);
  assert.equal(e.escalation.reason, "budget_exhausted");
  assert.equal(e.escalation.disposition, "defer");
  assert.equal(tier.count(), 0, "the key-presence gate kept the tier dormant");
  assert.equal(stub.count(), 2, "only the two Ollama rungs");
});

test("bin E2E: one-shot guard — the tier's refusal forces the terminal with the original reason", async (t) => {
  const site = await makeSite(t);
  const stub = await makeStub(t, { content: "no idea, sorry" });
  const tier = await makeTierStub(t, { content: "I cannot identify a locator for this step." });
  const repo = makeConsumerRepo(t);
  await generatePair(t, repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "pair");
  const runFolder = writeRun(t, repo);

  const { code, stdout } = await spawnHeal(t, repo, [runFolder], {
    WRAPPER_OLLAMA_BASE_URL: stub.url,
    WRAPPER_OPENAI_BASE_URL: tier.url,
    ...EXHAUSTED_ENV,
    E2E_BASE_URL: site,
  });
  assert.equal(code, 1);
  const e = JSON.parse(stdout);
  assert.equal(e.outcome, "no_proposal");
  assert.equal(e.third_tier.outcome, "no_proposal");
  assert.equal(e.attempts.third_tier, 1);
  assert.equal(e.escalation.reason, "budget_exhausted", "the ORIGINAL reason stands — no re-consult, no new reason");
  assert.equal(e.escalation.disposition, "defer");
  assert.equal(tier.count(), 1, "the one-shot budget: exactly one tier attempt");
  assert.equal(e.outcome_history.length, 2, "the history deficit for a no_proposal shot");
  const record = readFileSync(e.record, "utf8");
  assert.match(record, /^outcome: no_proposal$/m);
  assert.match(record, /^reason: budget_exhausted$/m);
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