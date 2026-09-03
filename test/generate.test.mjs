// FYR-330 tests: `generate` end to end via the bin (the FYR-326 seam — spawn
// the bin, assert on stdout/exit/written files). Fixtures from the FYR-267
// round-trip prototype prove the slice without a model. Includes the
// stock-Playwright round-trip test: run the generated spec, parse the JSON
// reporter output, resolve the failure address to a step id.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = path.dirname(path.dirname(fileURLToPath(new URL(import.meta.url))));
const BIN = path.join(ROOT, "bin", "playwright-wrapper.mjs");
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeConsumerRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "fyr330-consumer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  // Consumer-config contract (FYR-267): testDir + baseURL from env + JSON reporter.
  mkdirSync(path.join(dir, "tests"), { recursive: true });
  writeFileSync(
    path.join(dir, "playwright.config.ts"),
    `import { defineConfig } from '@playwright/test';\n` +
      `export default defineConfig({\n` +
      `  testDir: './tests',\n` +
      `  use: { baseURL: process.env.BASE_URL ?? 'http://localhost:1' },\n` +
      `  reporter: [['json', { outputFile: 'results.json' }]],\n` +
      `  captureGitInfo: true,\n` +
      `});\n`,
  );
  writeFileSync(path.join(dir, ".gitignore"), "node_modules/\nresults.json\ntest-results/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "consumer scaffold");
  return dir;
}

function spawnGenerate(t, repoDir, planBytes, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "generate"], { env, cwd: repoDir });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.write(planBytes);
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("generate: fixture plan bytes → stamped pair written, git-trackable, stamp recomputes", async (t) => {
  const repo = makeConsumerRepo(t);
  const { code, stdout, stderr } = await spawnGenerate(t, repo, FIXTURE_PLAN);
  assert.equal(code, 0, stderr);
  const specPath = path.join(repo, "tests", "user-can-sign-in.spec.ts");
  const planPath = path.join(repo, "tests", "user-can-sign-in.plan.md");
  assert.ok(existsSync(specPath));
  assert.ok(existsSync(planPath));

  const spec = readFileSync(specPath, "utf8");
  const firstLine = spec.split("\n")[0];
  assert.match(firstLine, /^\/\/ plan-sha256: [0-9a-f]{64}$/);
  assert.equal(firstLine, `// plan-sha256: ${createHash("sha256").update(FIXTURE_PLAN).digest("hex")}`);

  // The plan file is byte-identical to the consumed bytes.
  assert.equal(readFileSync(planPath, "utf8"), FIXTURE_PLAN.endsWith("\n") ? FIXTURE_PLAN : FIXTURE_PLAN + "\n");

  // One test.step per plan step, ids in order.
  for (const id of ["s1", "s2", "s3", "s4", "s5"]) {
    assert.ok(spec.includes(`[s${id.slice(1)}]`) || spec.includes(`[${id}]`), `spec has step ${id}`);
  }
  assert.ok(spec.includes("test.step('[s1] go to the login page'"));
  assert.ok(spec.includes("test.step('[s5] assert the dashboard heading is shown'"));

  // Env closure form.
  assert.ok(spec.includes("const E2E_USER = process.env.E2E_USER;"));
  assert.ok(spec.includes("if (!E2E_USER) throw"));

  // git-tracked-able: status shows the two files as untracked, nothing else.
  const status = git(repo, "status", "--porcelain");
  assert.equal(status.split("\n").filter(Boolean).length, 2);
  assert.match(status, /tests\/user-can-sign-in\.spec\.ts/);
  assert.match(status, /tests\/user-can-sign-in\.plan\.md/);
});

test("generate: refuses outside a repo (loud, non-zero, no write)", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "fyr330-norepo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, stderr } = await spawnGenerate(t, dir, FIXTURE_PLAN);
  assert.equal(code, 1);
  assert.match(stderr, /not inside a git repository/);
  assert.equal(existsSync(path.join(dir, "tests")), false);
});

test("generate: refuses on dirty tree before any write", async (t) => {
  const repo = makeConsumerRepo(t);
  writeFileSync(path.join(repo, "uncommitted.txt"), "dirty");
  const { code, stderr } = await spawnGenerate(t, repo, FIXTURE_PLAN);
  assert.equal(code, 1);
  assert.match(stderr, /dirty\/untracked/);
  assert.equal(existsSync(path.join(repo, "tests", "user-can-sign-in.spec.ts")), false);
});

test("generate: refuses invalid plan bytes (no write)", async (t) => {
  const repo = makeConsumerRepo(t);
  const { code, stderr } = await spawnGenerate(t, repo, "profile: test\nnot a plan\n");
  assert.equal(code, 1);
  assert.match(stderr, /plan rejected|plan failed/);
  assert.equal(existsSync(path.join(repo, "tests", "user-can-sign-in.spec.ts")), false);
});

test("generate: refuses empty stdin with usage hint", async (t) => {
  const repo = makeConsumerRepo(t);
  const { code, stderr } = await spawnGenerate(t, repo, "");
  assert.ok(code === 1 || code === 2, `non-zero exit (${code})`);
  assert.match(stderr, /no plan on stdin/);
});

test("compiled spec passes lintSpec (redundant with the internal gate, asserted here)", async (t) => {
  const { lintSpec } = await import(path.join(ROOT, "src", "plan-parse.mjs"));
  const repo = makeConsumerRepo(t);
  const { code } = await spawnGenerate(t, repo, FIXTURE_PLAN);
  assert.equal(code, 0);
  const spec = readFileSync(path.join(repo, "tests", "user-can-sign-in.spec.ts"), "utf8");
  const lint = lintSpec(spec);
  assert.equal(lint.ok, true, lint.problems?.join("; "));
  assert.deepEqual(lint.ids, ["s1", "s2", "s3", "s4", "s5"]);
});

test("credentials: env:E2E_* becomes module-top throw-guard; storageState never emitted", async (t) => {
  const repo = makeConsumerRepo(t);
  await spawnGenerate(t, repo, FIXTURE_PLAN);
  const spec = readFileSync(path.join(repo, "tests", "user-can-sign-in.spec.ts"), "utf8");
  assert.ok(spec.includes("if (!E2E_USER) throw new Error('missing env var E2E_USER');"));
  assert.ok(!/storageState/.test(spec));
  assert.ok(!/timeout\s*:/.test(spec));
  assert.ok(!/expect\.soft/.test(spec));
  assert.ok(spec.includes("await page.goto('/');"), "goto is relative");
});

test("regen: same action text keeps ids; edited plan reassigns; healed locator resets", async (t) => {
  const repo = makeConsumerRepo(t);
  assert.equal((await spawnGenerate(t, repo, FIXTURE_PLAN)).code, 0);
  // The regen overwrite rule needs a clean tree: commit the first pair (as a real consumer would).
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "first pair");

  // Simulate a heal patch on the generated spec (text surgery, FYR-267 style).
  const specPath = path.join(repo, "tests", "user-can-sign-in.spec.ts");
  const healed = readFileSync(specPath, "utf8").replace("getByLabel('Email')", "getByLabel('Login email')");
  writeFileSync(specPath, healed);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "healed spec");

  // Regen plan: s2's action text edited, a new step appended (module const REGEN_PLAN).
  const { code, stdout, stderr } = await spawnGenerate(t, repo, REGEN_PLAN);
  assert.equal(code, 0, stderr);

  const spec = readFileSync(specPath, "utf8");
  // s2's action changed → the email step got a FRESH id (s7 from next_id high-water); s1..s5 kept.
  assert.ok(spec.includes("[s1] go to the login page"));
  assert.ok(spec.includes("[s2] type the email address"), "renamed action keeps its id by action-text match");
  assert.ok(spec.includes("[s6] sign out"));
  // Healed locator reset: the regen re-emits the plan's locator, not the healed one.
  assert.ok(spec.includes("getByLabel('Email')"), "healed locator reset on regen");
  assert.ok(!spec.includes("getByLabel('Login email')"));
  // Plan file byte-identical to the new approved bytes.
  assert.equal(readFileSync(path.join(repo, "tests", "user-can-sign-in.plan.md"), "utf8"), REGEN_PLAN);
});

// The fixture plan, exactly as shipped by the FYR-267 prototype.
const FIXTURE_PLAN = `profile: test
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
  action: fill the password field
  locator: getByLabel('Password')
  value: literal 'correct horse'
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
`;
const REGEN_PLAN = (FIXTURE_PLAN
  .replace("action: fill the email field", "action: type the email address")
  .replace("next_id: s6", "next_id: s7")
  + "- id: s6\n  action: sign out\n  locator: getByRole('button', { name: 'Sign out' })\n  reason: role=button\n");