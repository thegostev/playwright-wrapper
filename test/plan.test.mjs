// FYR-329: plan subcommand tests.
//
// LLM interception at the API boundary (FYR-325 Testing Decisions): a stub
// server serves recorded fixtures on the env-configurable base URL — including
// deliberately malformed responses (bad fence, invented locator, bogus ids) to
// prove refusals-with-line-numbers over repair. The raw response is validated
// UNMODIFIED; step ids are harness-re-keyed; the plan prints to stdout on pass.
//
// The canned path (runPlan with rawModelResponse) exercises the emission
// verdict without a browser; the E2E test drives a real local page through the
// actual bridge with the LLM stubbed at the API boundary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.join(ROOT, "bin", "playwright-wrapper.mjs");

const SPEC = `profile: test
target: https://example.test/login

sign in with the email and password fields, submit the form, and verify the
dashboard heading is shown`;

// A grammar-valid plan the stub LLM can serve. Ids are deliberately BOGUS
// (x9, k2, k3) — the harness must re-key them (AC#3).
const VALID_RAW = `profile: test
title: sign in flow
file: sign-in-flow
next_id: s9
---
## steps

- id: x9
  action: go to the login page
  locator: none
  value: literal '/'
- id: k2
  action: submit the form
  locator: getByRole('button', { name: 'Sign in' })
  reason: role=button, name="Sign in"
- id: k3
  action: assert the dashboard heading is shown
  locator: getByRole('heading', { name: 'Dashboard' })
  expect: visible
  reason: role=heading`;

// Malformed: a fenced code block (the fence lines are not header keys).
const FENCED_RAW = "```yaml\n" + VALID_RAW + "\n```";

function spawnPlan(args, envOverrides = {}) {
  const env = {
    ...process.env,
    WRAPPER_OLLAMA_API_KEY: "test-key-not-a-real-secret",
    ...envOverrides,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "plan", ...args], { env, cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("plan (canned): a grammar-valid raw response is re-keyed and validated (AC#1, AC#3)", async (t) => {
  const { runPlan } = await import("../bin/lib/plan.mjs");
  const res = await runPlan({ specText: SPEC, config: {}, rawModelResponse: VALID_RAW });
  assert.match(res.planText, /^profile: test\n/, "the plan opens with the header");
  // The model's bogus ids (x9, k2, k3) are re-keyed s1..s3 in step order.
  assert.match(res.planText, /- id: s1\n  action: go to the login page/, "first step re-keyed s1");
  assert.match(res.planText, /- id: s2\n  action: submit the form/, "second step re-keyed s2");
  assert.match(res.planText, /- id: s3\n  action: assert the dashboard heading/, "third step re-keyed s3");
  assert.ok(!/id: (x9|k2|k3)/.test(res.planText), "model-authored ids are gone");
  assert.match(res.planText, /^next_id: s4$/m, "next_id recomputed as high-water + 1");
  assert.deepEqual(res.envNames, [], "no env names in this plan");
});

test("plan (canned): a malformed raw response is refused with line numbers, zero repair (AC#2)", async (t) => {
  const { runPlan } = await import("../bin/lib/plan.mjs");
  const err = await runPlan({ specText: SPEC, config: {}, rawModelResponse: FENCED_RAW }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "the fenced response is refused");
  assert.match(err.message, /plan rejected/);
  assert.match(err.message, /line 1/, "the refusal carries a line number");
  // No repaired plan anywhere: the refusal names the raw bytes' violation,
  // it never offers the stripped plan as a fallback.
  assert.ok(!err.message.includes("## steps\n\n- id: s1\n  action: go to the login page\n-"), "no repaired plan in the message");
});

test("plan (bin): missing spec argument exits 2 with usage (no LLM call, no browser)", async () => {
  const { code, stderr } = await spawnPlan([]);
  assert.equal(code, 2);
  assert.match(stderr, /missing spec argument/);
});

test("plan (bin): unreadable spec file exits 2", async () => {
  const { code, stderr } = await spawnPlan(["/nonexistent/spec.txt"]);
  assert.equal(code, 2);
  assert.match(stderr, /cannot read spec file/);
});

test("plan (bin): invalid task spec refused with line numbers, exit 2 (boundary validation before any model call)", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const dir = mkdtempSync(path.join(ROOT, ".scratch-fyr329-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const specPath = path.join(dir, "bad.spec.txt");
  writeFileSync(specPath, "profile: integration\ntarget: notaurl\n\nthe goal\n");
  const { code, stderr } = await spawnPlan([specPath]);
  assert.equal(code, 2, "invalid spec exits 2");
  assert.match(stderr, /task spec refused/);
  assert.match(stderr, /line 1: profile must be "test" or "browsing"/);
  assert.match(stderr, /line 2: target must be an absolute http\(s\) URL/);
});

test("plan (bin): profile browsing refuses — plan is the test-profile surface only", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const dir = mkdtempSync(path.join(ROOT, ".scratch-fyr329-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const specPath = path.join(dir, "browse.spec.txt");
  writeFileSync(specPath, "profile: browsing\ntarget: https://example.test\n\nthe goal\n");
  const { code, stderr } = await spawnPlan([specPath]);
  assert.equal(code, 1);
  assert.match(stderr, /plan serves the test profile only/);
});

test("plan (real browser, stub LLM): the live snapshot + the NL goal reach the LLM call; re-keyed plan on stdout (AC#1, AC#4 E2E)", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const INDEX_HTML = `<!doctype html><html><body>
  <main><h1>Bridge home</h1><a href="/target">open the target page</a></main>
</body></html>`;
  const site = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(INDEX_HTML);
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(path.join(ROOT, ".scratch-fyr329-"));
  const specPath = path.join(dir, "spec.txt");
  writeFileSync(specPath, `profile: test\ntarget: http://127.0.0.1:${site.address().port}/\n\nverify the bridge home heading is shown\n`);
  t.after(() => {
    site.close();
    rmSync(dir, { recursive: true });
  });

  let userTurn = "";
  const stub = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      userTurn = parsed.messages?.find((m) => m.role === "user")?.content ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "stub",
          object: "chat.completion",
          created: 0,
          model: "stub-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content:
                  "profile: test\ntitle: bridge home\nfile: bridge-home\nnext_id: s9\n---\n## steps\n\n- id: q1\n  action: go to the home page\n  locator: none\n  value: literal '/'\n- id: q2\n  action: assert the bridge home heading is shown\n  locator: getByRole('heading', { name: 'Bridge home' })\n  expect: visible\n  reason: role=heading",
                reasoning_content: "r".repeat(150),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 300, total_tokens: 310 },
        }),
      );
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  t.after(() => stub.close());

  const { code, stdout, stderr } = await spawnPlan([specPath], {
    WRAPPER_OLLAMA_BASE_URL: `http://127.0.0.1:${stub.address().port}/v1`,
  });
  assert.equal(code, 0, `plan exits 0 (stderr: ${stderr})`);
  assert.match(userTurn, /heading "Bridge home" \[level=1\]/, "the live snapshot reached the LLM user turn");
  assert.match(userTurn, /verify the bridge home heading is shown/, "the NL goal reached the LLM user turn");
  assert.match(userTurn, /system/i === null ? /x/ : /TASK:/, "the user turn is the task shape");
  // The stdout plan is the re-keyed artifact (model ids q1/q2 → s1/s2).
  assert.match(stdout, /- id: s1\n  action: go to the home page/);
  assert.match(stdout, /- id: s2\n  action: assert the bridge home heading/);
  assert.match(stdout, /^next_id: s3$/m);
});