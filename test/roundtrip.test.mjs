// FYR-330 AC#4: the full round-trip, stock Playwright only.
//
//   generate (the real bin) → stamped pair in a consumer repo →
//   run the GENERATED spec with the stock JSON reporter against a local site →
//   the failure's error node sits on the outermost test.step('[sN] …') entry
//   (results.json carries only test.step entries — the FYR-267 spike proved
//   the reporter filters expect/API steps) → the failing step's id is
//   recoverable, which is exactly what the heal loop (FYR-329/333) consumes.
//
// One intentional defect: the plan's button locator says 'Log in', the page's
// button says 'Sign in' → the run fails at [s4]; the id round-trips.

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
const PW_CLI = path.join(ROOT, "node_modules", "playwright", "cli.js");

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

// The one intentional defect lives in s4's locator ('Log in' vs 'Sign in').
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
    <script>
      document.getElementById('login').addEventListener('submit', (e) => {
        e.preventDefault();
        location.href = '/dashboard';
      });
    </script>
  </main>
</body>
</html>`;
const DASHBOARD_HTML = `<!doctype html><html><body><h1>Dashboard</h1></body></html>`;

// Minimal consumer config: JSON reporter to results.json (the FYR-249 CI shape).
const CONSUMER_CONFIG = `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  workers: 1,
  use: { baseURL: process.env.E2E_BASE_URL, actionTimeout: 1500 },
  reporter: [['json', { outputFile: 'results.json' }]],
});
`;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeConsumerRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "fyr330-roundtrip-"));
  t.after(() => rmSyncNoThrow(dir));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  mkdirSync(path.join(dir, "tests"), { recursive: true });
  writeFileSync(path.join(dir, "playwright.config.ts"), CONSUMER_CONFIG);
  // Keep the tree gate happy and the run hermetic: ignore run artifacts.
  writeFileSync(path.join(dir, ".gitignore"), "node_modules/\nresults.json\ntest-results/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "scaffold");
  return dir;
}

function rmSyncNoThrow(dir) {
  try {
    execFileSync("rm", ["-rf", dir]);
  } catch {
    /* best effort */
  }
}

function spawnGenerate(t, repo, planText) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "generate"], {
      cwd: repo,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.write(planText);
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runPlaywright(repo, baseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PW_CLI, "test", "--config", "playwright.config.ts"], {
      cwd: repo,
      env: {
        ...process.env,
        E2E_BASE_URL: baseUrl,
        E2E_USER: "roundtrip@example.com",
        CI: "",
        // The consumer repo is a throwaway tmpdir with no node_modules; the
        // '@playwright/test' import resolves through the wrapper's install.
        NODE_PATH: path.join(ROOT, "node_modules"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("playwright run timed out"));
    }, 120_000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, out });
    });
    child.on("error", reject);
  });
}

test("generate → stock Playwright run: failing step's id round-trips through the JSON report", async (t) => {
  const server = createServer((req, res) => {
    const file = req.url === "/dashboard" ? DASHBOARD_HTML : req.url === "/" ? INDEX_HTML : null;
    if (!file) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(file);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const repo = makeConsumerRepo(t);

  // 1. generate: the REAL bin writes the stamped pair into the consumer repo.
  const gen = await spawnGenerate(t, repo, FIXTURE_PLAN);
  assert.equal(gen.code, 0, gen.stderr);
  const specPath = path.join(repo, "tests", "user-can-sign-in.spec.ts");
  assert.ok(existsSync(specPath), "generated spec exists");

  // 2. Run the GENERATED spec with the stock JSON reporter. Expect failure at s4.
  const run = await runPlaywright(repo, baseUrl);
  assert.equal(run.status, 1, `playwright exits non-zero (failure expected): ${run.out.slice(-400)}`);
  const results = JSON.parse(readFileSync(path.join(repo, "results.json"), "utf8"));
  const result = results.suites?.[0]?.specs?.[0]?.tests?.[0]?.results?.[0];
  assert.ok(result, "json report has the test result");
  assert.equal(result.status, "failed", "the spec fails (intentional locator defect)");

  // 3. The JSON carries ONLY test.step entries; walk the tree and take the
  //    first (outermost) node with an error whose title matches ^\[(s\d+)\].
  const walk = (steps) => {
    for (const step of steps ?? []) {
      if (step.error && /^\[(s\d+)\]\s/.test(step.title)) return step.title.match(/^\[(s\d+)\]/)[1];
      const inner = walk(step.steps);
      if (inner) return inner;
    }
    return null;
  };
  const failingId = walk(result.steps);
  assert.equal(failingId, "s4", "the failure's address resolves to step id s4");
  const titles = (result.steps ?? []).map((s) => s.title);
  assert.ok(titles.every((title) => /^\[s\d+\]\s/.test(title)), `only [sN] step entries in JSON: ${JSON.stringify(titles)}`);

  // 4. Heal by editing the plan (the consumer's real workflow: re-approve and
  //    regen), regen keeps ids for unchanged actions, then the rerun passes —
  //    the write half of the round-trip.
  const healedPlan = FIXTURE_PLAN.replace("name: 'Log in'", "name: 'Sign in'");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "first pair");
  const regen = await spawnGenerate(t, repo, healedPlan);
  assert.equal(regen.code, 0, regen.stderr);
  const healedSpec = readFileSync(specPath, "utf8");
  assert.ok(healedSpec.includes("name: 'Sign in'"), "regen carries the corrected locator");
  assert.ok(healedSpec.includes("test.step('[s4] submit the form'"), "s4 keeps its id (action text unchanged)");

  const rerun = await runPlaywright(repo, baseUrl);
  assert.equal(rerun.status, 0, `healed spec passes: ${rerun.out.slice(-400)}`);
});