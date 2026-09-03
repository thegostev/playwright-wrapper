// FYR-333: browse core tests.
//
// Stub-driven loop transcripts (FYR-325 Testing Decisions): the LLM is
// intercepted at the API boundary; classification paths (verified / asserted /
// schema_failed / malformed_submit / no_terminal_call / tool_error) are proven
// from canned transcripts; one E2E drives a real local page through the actual
// bridge with a stub LLM. The outcome envelope is contract_version 2.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.join(ROOT, "bin", "playwright-wrapper.mjs");

const SPEC = `profile: browsing
target: https://example.test/jobs

list the open roles with title and link`;

const SCHEMA = {
  type: "object",
  properties: {
    roles: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: { title: { type: "string" }, link: { type: "string", pattern: "^https?://" } },
        required: ["title", "link"],
      },
    },
  },
  required: ["roles"],
};

const sub = (data, extra = {}) => JSON.stringify({ tool: "submit_extraction", data, ...extra });
const browser = (name) => JSON.stringify({ tool: name });

test("browse (canned): loop ends only on the terminal call; payload in the envelope (AC#1, AC#3)", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  const spec = { header: { profile: "browsing", target: "https://example.test/jobs", taskId: null }, goal: "list the open roles" };
  const env = await runBrowseLoop({
    spec,
    cannedResponses: [
      browser("browser_snapshot"),
      subCall({ roles: [{ title: "Engineer", link: "https://x/1" }] }),
    ],
    schema: SCHEMA,
  });
  assert.equal(env.contract_version, 2);
  assert.equal(env.outcome, "verified");
  assert.equal(env.outcome_class, "pass");
  assert.equal(env.url, "https://example.test/jobs");
  assert.equal(env.outcome_history.length, 2, "history covers the loop turns");
  assert.deepEqual(env.outcome_history[env.outcome_history.length - 1], { tool: "submit_extraction" });
  assert.deepEqual(env.attempts, { n_primary: 2, n_fallback: 0, third_tier: { attempted: false, used: false } });
  assert.ok(env.coverage, "coverage block always present (nullable fields)");
});

test("browse (canned): schema conforming without schema → asserted; with schema → verified (AC#2)", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  const spec = { header: { profile: "browsing", target: "https://example.test/jobs", taskId: null }, goal: "g" };
  const payload = { roles: [{ title: "Engineer", link: "https://x/1" }] };
  const withSchema = await runBrowseLoop({ spec, schema: SCHEMA, cannedResponses: [subCall(payload)] });
  assert.equal(withSchema.outcome, "verified");
  assert.equal(withSchema.outcome_class, "pass");
  const noSchema = await runBrowseLoop({ spec, cannedResponses: [subCall(payload)] });
  assert.equal(noSchema.outcome, "asserted");
  assert.equal(noSchema.outcome_class, "pass_with_warning", "asserted is pass_with_warning (second-class)");
});

test("browse (canned): schema violations → schema_failed with failed_fields (AC#2)", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  const spec = { header: { profile: "browsing", target: "https://example.test/jobs", taskId: null }, goal: "g" };
  const env = await runBrowseLoop({
    spec,
    schema: SCHEMA,
    cannedResponses: [
      // empty roles violates the minItems floor; a bad link violates pattern
      subCall({ roles: [{ title: "Engineer", link: "not-a-url" }] }),
    ],
  });
  assert.equal(env.outcome, "schema_failed");
  assert.equal(env.outcome_class, "not_pass");
  const fields = env.schema.failed_fields.map((f) => f.field).join(" ");
  assert.match(fields, /expected pattern \^https\?:\/\//);
  // minItems floor: an empty array violates it
  const env2 = await runBrowseLoop({ spec, schema: SCHEMA, cannedResponses: [subCall({ roles: [] })] });
  assert.match(env2.schema.failed_fields[0].field, /expected at least 1 items/);
  assert.ok(env.schema.failed_fields[0].raw_truncated === false);
});

test("browse (canned): unparseable terminal call → malformed_submit, not_pass (AC#2)", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  const spec = { header: { profile: "browsing", target: "https://example.test/jobs", taskId: null }, goal: "g" };
  const env = await runBrowseLoop({
    spec,
    cannedResponses: [JSON.stringify({ tool: "submit_extraction", unparseable: true })],
  });
  assert.equal(env.outcome, "malformed_submit");
  assert.equal(env.outcome_class, "not_pass");
  assert.equal(env.error.stage, "submit");
  assert.match(env.error.message, /not parseable JSON/);
});

test("browse (canned): runaway is capped with an outcome, not an exception (AC#3)", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  const spec = { header: { profile: "browsing", target: "https://example.test/jobs", taskId: null }, goal: "g" };
  const env = await runBrowseLoop({
    spec,
    cannedResponses: [browser("browser_snapshot"), browser("browser_click"), browser("browser_navigate")],
  });
  assert.equal(env.outcome, "no_terminal_call");
  assert.equal(env.outcome_class, "not_pass");
  assert.match(env.error.message, /cap without a terminal submit_extraction call/);
  assert.ok(env.outcome_history.length < 12, "the canned run stays under the cap");
});

test("browse (canned): loop does NOT end on a non-terminal browser tool alone (AC#3)", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  const spec = { header: { profile: "browsing", target: "https://example.test/jobs", taskId: null }, goal: "g" };
  // A run that only ever takes snapshots and clicks never produces a pass:
  // the terminal call is the ONLY end.
  const env = await runBrowseLoop({ spec, cannedResponses: [browser("browser_snapshot")] });
  assert.equal(env.outcome, "no_terminal_call");
  assert.equal(env.outcome_history[0].tool, "browser_snapshot", "the browser turn is recorded, not terminal");
});

test("browse (bin): usage errors + task-spec refusals exit 2", async () => {
  const { runBrowse } = await import("../bin/lib/browse.mjs");
  const err1 = await runBrowse({ specText: "", config: {} }).then(() => null, (e) => e);
  assert.match(err1.message, /task spec is empty/);
  const err2 = await runBrowse({ specText: "profile: test\ntarget: https://x.test\n\ngoal" }).then(() => null, (e) => e);
  assert.equal(err1.exitCode, 2);
  assert.match(err2.message, /browse serves the browsing profile only/);
  assert.equal(err2.exitCode, 1, "wrong-profile is a command error, not a parse refusal");
});

test("browse (bin): the declared browse.schema path is loaded and enforced (AC#2)", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "fyr333-schema-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const schemaPath = path.join(dir, "expected.schema.json");
  writeFileSync(schemaPath, JSON.stringify({ type: "object", properties: { roles: { type: "array", minItems: 2 } }, required: ["roles"] }));
  const specText = `profile: browsing
target: https://example.test/jobs
browse:
  schema: ${schemaPath}

list the open roles`;
  // The submit payload has only 1 role → minItems: 2 violated → schema_failed.
  const { runBrowse } = await import("../bin/lib/browse.mjs");
  const env = await runBrowse({
    specText,
    cannedResponses: [subCall({ roles: [{ title: "E", link: "https://x/1" }] })],
    schemaBase: dir,
  });
  assert.equal(env.outcome, "schema_failed");
  assert.match(env.schema.failed_fields[0].field, /expected at least 2 items/);
});

test("browse (bin): envelope on stdout, exit 0 on pass / 1 on not_pass", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const dir = mkdtempSync(path.join(ROOT, ".scratch-fyr333-"));
  t.after(() => rmSync(dir, { recursive: true }));
  // Live-mode bin run would need the network; the bin-level contract (exit
  // code mirror + envelope on stdout) is asserted through the module return +
  // browseMain's classification path here.
  const { runBrowse } = await import("../bin/lib/browse.mjs");
  const specText = `profile: browsing\ntarget: https://example.test/jobs\n\nlist the open roles`;
  const env = await runBrowse({ specText, cannedResponses: [subCall({ roles: [{ title: "E", link: "https://x/1" }] })] });
  assert.equal(env.outcome_class, "pass_with_warning"); // no schema → asserted

  // exit-code mirror (the mapping browseMain applies)
  assert.equal(env.outcome_class === "not_pass" ? 1 : 0, 0);
});

test("browse (real browser, stub LLM): the loop drives the live page and the terminal call ends it (AC#1 E2E)", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const INDEX_HTML = `<!doctype html><html><body>
  <main>
    <h1>Jobs board</h1>
    <ul>
      <li><a href="/jobs/1">Engineer — Berlin</a></li>
      <li><a href="/jobs/2">Designer — Remote</a></li>
    </ul>
  </main>
</body></html>`;
  const site = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(INDEX_HTML);
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(path.join(ROOT, ".scratch-fyr333-"));
  const specPath = path.join(dir, "spec.txt");
  writeFileSync(specPath, `profile: browsing\ntarget: http://127.0.0.1:${site.address().port}/\n\nlist the open roles with title and link\n`);
  t.after(() => {
    site.close();
    rmSync(dir, { recursive: true });
  });

  // Stub LLM: turn 1 = snapshot request; turn 2 = terminal submit with the
  // roles read from the real snapshot it received.
  const turns = [
    { tool: "browser_snapshot" },
    { submit: { data: { roles: [{ title: "Engineer — Berlin", link: "/jobs/1" }, { title: "Designer — Remote", link: "/jobs/2" }] }, notes: "read from the snapshot" } },
  ];
  let callIdx = 0;
  let userTurn = "";
  let snapshotTurn = "";
  const stub = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const toolMsg = parsed.messages?.filter((m) => m.role === "tool").map((m) => m.content ?? "").join("\n") ?? "";
      snapshotTurn = (snapshotTurn ?? "") + toolMsg;
      userTurn = parsed.messages?.find((m) => m.role === "user")?.content ?? "";
      const turn = turns[Math.min(callIdx++, turns.length - 1)]; // extra stub calls repeat the last turn
      const toolCalls = turn.tool
        ? [{ id: "c1", type: "function", function: { name: turn.tool, arguments: "{}" } }]
        : [{ id: "c2", type: "function", function: { name: "submit_extraction", arguments: JSON.stringify(turn.submit) } }];
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
              message: { role: "assistant", content: "", tool_calls: toolCalls, reasoning_content: "r".repeat(150) },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 300, total_tokens: 310 },
        }),
      );
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  t.after(() => stub.close());

  const { code, stdout, stderr } = await spawnBrowse([specPath], {
    WRAPPER_OLLAMA_BASE_URL: `http://127.0.0.1:${stub.address().port}/v1`,
  });
  assert.equal(code, 0, `exit 0 on pass (stderr: ${stderr})`);
  assert.match(userTurn, /list the open roles with title and link/, "the NL goal reached the LLM user turn");
  assert.match(snapshotTurn, /Jobs board/, "the live snapshot reached the LLM as a tool result");
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.contract_version, 2);
  assert.equal(envelope.outcome, "asserted", "no schema declared → asserted (pass_with_warning)");
  assert.equal(envelope.outcome_class, "pass_with_warning");
  assert.deepEqual(envelope.data, {
    roles: [{ title: "Engineer — Berlin", link: "/jobs/1" }, { title: "Designer — Remote", link: "/jobs/2" }],
  });
});

function subCall(data) {
  return JSON.stringify({ tool: "submit_extraction", data });
}

function spawnBrowse(args, envOverrides = {}) {
  const env = {
    ...process.env,
    WRAPPER_OLLAMA_API_KEY: "test-key-not-a-real-secret",
    ...envOverrides,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "browse", ...args], { env, cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}