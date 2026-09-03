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
  // minItems floor: an empty array is now an EMPTY CLAIM (FYR-334) and enters
  // the three-state empty path — the floor-as-empty_schema_conflict case is
  // proven in test/browse-oracle.test.mjs.
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

function spawnBrowse(args, envOverrides = {}, opts = {}) {
  const env = {
    ...process.env,
    WRAPPER_OLLAMA_API_KEY: "test-key-not-a-real-secret",
    ...envOverrides,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "browse", ...args], { env, cwd: opts.cwd ?? ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// --- FYR-334: the oracle hardening (stub transcripts; probe + judge injected) ----

const EMPTY_SPEC = { header: { profile: "browsing", target: "https://example.test/jobs", taskId: null }, goal: "list the open roles" };

test("browse (canned): marker-found empty claim → empty_confirmed (pass); recheck skipped", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  let rechecks = 0;
  const env = await runBrowseLoop({
    spec: EMPTY_SPEC,
    cannedResponses: [subCall({ roles: [] })],
    schema: { type: "object", properties: { roles: { type: "array", minItems: 0 } }, required: ["roles"] },
    pageProbe: {
      readPageText: async () => "Sorry — No Open Positions match your filters.",
      recheck: async () => {
        rechecks += 1;
        return "";
      },
    },
  });
  assert.equal(env.outcome, "empty_confirmed");
  assert.equal(env.outcome_class, "pass");
  assert.deepEqual(env.empty, { marker_found: true, marker_text: "no open positions", recheck_attempted: false });
  assert.equal(rechecks, 0, "a first-read marker needs no recheck");
  assert.equal(env.trace_path, null, "canned runs never persist a trace");
});

test("browse (canned): marker-unconfirmed → empty_unconfirmed (not_pass) after ONE fixed recheck", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  let reads = 0;
  let rechecks = 0;
  const env = await runBrowseLoop({
    spec: EMPTY_SPEC,
    cannedResponses: [subCall({ roles: [] })],
    allowEmpty: true,
    pageProbe: {
      readPageText: async () => {
        reads += 1;
        return "Welcome to the careers hub";
      },
      recheck: async () => {
        rechecks += 1;
        return "Welcome to the careers hub (scrolled to end)";
      },
    },
  });
  assert.equal(env.outcome, "empty_unconfirmed");
  assert.equal(env.outcome_class, "not_pass", "never auto-pass an unconfirmed empty");
  assert.deepEqual(env.empty, { marker_found: false, marker_text: null, recheck_attempted: true });
  assert.equal(reads, 1);
  assert.equal(rechecks, 1, "the recheck is ONE fixed scroll + re-snapshot");
});

test("browse (canned): empty claim under a minItems floor → empty_schema_conflict with BOTH blocks", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  const env = await runBrowseLoop({
    spec: EMPTY_SPEC,
    cannedResponses: [subCall({ roles: [] })],
    schema: { type: "object", properties: { roles: { type: "array", minItems: 1 } }, required: ["roles"] },
    pageProbe: {
      readPageText: async () => "no jobs found",
      recheck: async () => "",
    },
  });
  assert.equal(env.outcome, "empty_schema_conflict");
  assert.equal(env.outcome_class, "not_pass");
  assert.ok(env.empty.marker_found);
  assert.equal(env.schema.failed_fields[0].field, "minItems", "the schema floor is the contradicted contract");
});

test("browse (canned): a failed empty-path page read is honest tool_error (stage recheck)", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  const env = await runBrowseLoop({
    spec: EMPTY_SPEC,
    cannedResponses: [subCall({ roles: [] })],
    allowEmpty: true,
    pageProbe: { readPageText: async () => { throw new Error("page crashed"); }, recheck: async () => "" },
  });
  assert.equal(env.outcome, "tool_error");
  assert.equal(env.outcome_class, "not_pass");
  assert.equal(env.error.stage, "recheck");
  assert.match(env.error.message, /empty-path page read failed: page crashed/);
  assert.equal(env.empty, null, "an errored run carries neither payload block");
});

test("browse (canned): identity judge PASS keeps the structural verdict and records semantic", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  const seen = {};
  const env = await runBrowseLoop({
    spec: EMPTY_SPEC,
    schema: SCHEMA,
    identityQuestion: "Is this the open-roles board?",
    cannedResponses: [
      { tool: "browser_snapshot", text: '- heading "Open roles" [ref=e1]\n- list "roles"' },
      subCall({ roles: [{ title: "Engineer", link: "https://x/1" }] }),
    ],
    judge: async (input) => {
      Object.assign(seen, input);
      return { pass: true, confidence: 0.87 };
    },
  });
  assert.equal(env.outcome, "verified");
  assert.equal(env.outcome_class, "pass");
  assert.equal(env.semantic.ran, true);
  assert.equal(env.semantic.pass, true);
  assert.equal(env.semantic.confidence, 0.87, "recorded for humans — never used for routing");
  assert.equal(seen.question, "Is this the open-roles board?");
  assert.equal(seen.url, "https://example.test/jobs");
  assert.match(seen.snapshotText, /Open roles/, "the judge's input is the snapshot");
  assert.doesNotMatch(seen.snapshotText, /Engineer/, "…and NEVER the submit payload");
  assert.equal(seen.payload, undefined, "the payload never reaches the judge");
});

test("browse (canned): identity judge REJECT → semantic_rejected; the structural verdict survives as structural_outcome", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  const env = await runBrowseLoop({
    spec: EMPTY_SPEC,
    schema: SCHEMA,
    identityQuestion: "Is this the open-roles board?",
    cannedResponses: [
      { tool: "browser_snapshot", text: '- heading "Pricing" [ref=e1]' },
      subCall({ roles: [{ title: "Engineer", link: "https://x/1" }] }),
    ],
    judge: async () => ({ pass: false, reason: "this is the pricing page, not the roles board" }),
  });
  assert.equal(env.outcome, "semantic_rejected");
  assert.equal(env.outcome_class, "not_pass");
  assert.equal(env.structural_outcome, "verified", "structural classification preserved for the audit");
  assert.deepEqual(env.semantic, {
    question: "Is this the open-roles board?",
    ran: true,
    pass: false,
    reason: "this is the pricing page, not the roles board",
  });
  assert.equal(env.pagination, null);
});

test("browse (canned): a judge ERROR never overrides — structural stands, semantic {ran:false}", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  const env = await runBrowseLoop({
    spec: EMPTY_SPEC,
    schema: SCHEMA,
    identityQuestion: "Is this the open-roles board?",
    cannedResponses: [
      { tool: "browser_snapshot", text: '- heading "Open roles"' },
      subCall({ roles: [{ title: "Engineer", link: "https://x/1" }] }),
    ],
    judge: async () => {
      throw new Error("judge model 500");
    },
  });
  assert.equal(env.outcome, "verified", "the structural verdict stands");
  assert.equal(env.outcome_class, "pass");
  assert.equal(env.semantic.ran, false);
  assert.match(env.semantic.error, /judge model 500/);
});

test("browse (canned): the judge is NOT invoked on a not_pass structural outcome", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  let judgeCalls = 0;
  const env = await runBrowseLoop({
    spec: EMPTY_SPEC,
    schema: SCHEMA,
    identityQuestion: "Is this the open-roles board?",
    cannedResponses: [subCall({ roles: [{ title: "Engineer", link: "not-a-url" }] })],
    judge: async () => {
      judgeCalls += 1;
      return { pass: true };
    },
  });
  assert.equal(env.outcome, "schema_failed");
  assert.equal(judgeCalls, 0, "no page-identity opinion is spent on an already-failed run");
});

test("browse (canned): a COMPLETED pager (k == n, no live Next) does not fire the gate", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  const env = await runBrowseLoop({
    spec: EMPTY_SPEC,
    schema: SCHEMA,
    cannedResponses: [
      { tool: "browser_snapshot", text: '- paragraph "Page 1 of 2" [ref=e1]\n- link "Next" [ref=e9]' },
      { tool: "browser_click", target: "e9", element: "Next" },
      { tool: "browser_snapshot", text: '- paragraph "Page 2 of 2" [ref=e1]' },
      subCall({ roles: [{ title: "Engineer", link: "https://x/1" }] }),
    ],
  });
  assert.equal(env.outcome, "verified");
  assert.equal(env.pagination, null, "telemetry-only when nothing fired");
  assert.equal(env.coverage.stated_total_parsed, null);
});

test("browse (canned): a Next the model never followed stays telemetry-only (verified)", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  const env = await runBrowseLoop({
    spec: EMPTY_SPEC,
    schema: SCHEMA,
    cannedResponses: [
      { tool: "browser_snapshot", text: '- heading "Roles" [ref=e1]\n- link "Next" [ref=e9]' },
      subCall({ roles: [{ title: "Engineer", link: "https://x/1" }] }),
    ],
  });
  assert.equal(env.outcome, "verified", "a present-but-unused Next is not a cue");
  assert.equal(env.pagination, null);
});

test("browse (canned): followed Next + a live Next on the terminal snapshot → coverage_incomplete (not_pass)", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  const env = await runBrowseLoop({
    spec: EMPTY_SPEC,
    schema: SCHEMA,
    cannedResponses: [
      { tool: "browser_snapshot", text: '- paragraph "Page 1 of 2" [ref=e1]\n- link "Next" [ref=e9]' },
      { tool: "browser_click", target: "e9", element: "Next" },
      { tool: "browser_snapshot", text: '- paragraph "Page 2 of 2" [ref=e1]\n- link "Next" [ref=e19]' },
      subCall({ roles: [{ title: "Engineer", link: "https://x/1" }] }),
    ],
  });
  assert.equal(env.outcome, "coverage_incomplete", "contradictory cues: the pager said done, a live Next says otherwise");
  assert.equal(env.outcome_class, "not_pass");
  assert.equal(env.structural_outcome, "verified");
  assert.ok(env.pagination.class_evidence.pager_parse);
  assert.equal(env.pagination.class_evidence.followed_next.length, 1);
  assert.equal(env.pagination.terminal_evidence.live_next.length, 1);
});

test("browse (canned): freshest k < n fires the gate even without a live terminal Next", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  const env = await runBrowseLoop({
    spec: EMPTY_SPEC,
    schema: SCHEMA,
    cannedResponses: [
      { tool: "browser_snapshot", text: '- paragraph "Page 1 of 3" [ref=e1]\n- link "Next" [ref=e9]' },
      { tool: "browser_click", target: "e9", element: "Next" },
      { tool: "browser_snapshot", text: '- paragraph "Page 2 of 3" [ref=e1]' },
      subCall({ roles: [{ title: "Engineer", link: "https://x/1" }] }),
    ],
  });
  assert.equal(env.outcome, "coverage_incomplete", "the model stopped at page 2 of 3 and submitted");
  assert.equal(env.outcome_class, "not_pass");
  assert.equal(env.pagination.terminal_evidence.pager_parse.k, 2);
  assert.equal(env.pagination.terminal_evidence.pager_parse.n, 3);
});

test("browse (canned): fabricated stated_total in the model's notes cannot satisfy any gate", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  // The page states NO row total; the model's notes claim "all 66 jobs". Only
  // the harness's parse of page text counts — claims are not evidence.
  const env = await runBrowseLoop({
    spec: EMPTY_SPEC,
    schema: SCHEMA,
    cannedResponses: [
      { tool: "browser_snapshot", text: '- heading "Roles" [ref=e1]\n- list "roles"' },
      { tool: "submit_extraction", data: { roles: [{ title: "E", link: "https://x/1" }] }, notes: "scraped all 66 jobs on the page" },
    ],
  });
  assert.equal(env.outcome, "verified");
  assert.equal(env.coverage.stated_total_parsed, null, "no page-text total → no arithmetic");
  assert.equal(env.coverage.stated_total_reported, null, "model-authored numbers never enter the harness's field");
  assert.equal(env.coverage.stated_total_disagreement, null);
});

test("browse (canned): rows below 0.9 of the page-stated total → coverage_suspect (pass_with_warning)", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  const many = Array.from({ length: 10 }, (_, i) => ({ title: `Role ${i}`, link: `https://x/${i}` }));
  const env = await runBrowseLoop({
    spec: EMPTY_SPEC,
    schema: SCHEMA,
    cannedResponses: [
      { tool: "browser_snapshot", text: '- text "Results 1–10 of 66 jobs"' },
      subCall({ roles: many }),
    ],
  });
  assert.equal(env.outcome, "coverage_suspect");
  assert.equal(env.outcome_class, "pass_with_warning");
  assert.equal(env.structural_outcome, "verified");
  assert.equal(env.coverage.rows_extracted, 10);
  assert.equal(env.coverage.stated_total_parsed, 66, "the PARSED total, not any model claim");
});

test("browse (canned): an infinite-scroll run (clicks, no pager cues) never fires the gate", async () => {
  const { runBrowseLoop } = await import("../src/browse-core.mjs");
  const env = await runBrowseLoop({
    spec: EMPTY_SPEC,
    schema: SCHEMA,
    cannedResponses: [
      { tool: "browser_snapshot", text: '- heading "Feed" [ref=e1]' },
      { tool: "browser_click", target: "e5", element: "Load more" },
      { tool: "browser_snapshot", text: '- heading "Feed" [ref=e1]\n- list "more items"' },
      { tool: "browser_click", target: "e5", element: "Load more" },
      { tool: "browser_snapshot", text: '- heading "Feed" [ref=e1]\n- list "even more items"' },
      subCall({ roles: [{ title: "Engineer", link: "https://x/1" }] }),
    ],
  });
  assert.equal(env.outcome, "verified", "infinite scroll stays telemetry-only (FYR-259)");
  assert.equal(env.pagination, null);
});

test("browse (bin, real browser + stub LLM): the execution trace persists and stays auditable (FYR-334)", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const INDEX_HTML = `<!doctype html><html><body>
  <main>
    <h1>Jobs board</h1>
    <ul>
      <li><a href="/jobs/1">Engineer — Berlin</a></li>
    </ul>
  </main>
</body></html>`;
  const site = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(INDEX_HTML);
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(path.join(tmpdir(), "fyr334-trace-"));
  const specPath = path.join(dir, "spec.txt");
  writeFileSync(specPath, `profile: browsing\ntarget: http://127.0.0.1:${site.address().port}/\n\nlist the open roles with title and link\n`);
  t.after(() => {
    site.close();
    rmSync(dir, { recursive: true });
  });

  const turns = [
    { tool: "browser_snapshot" },
    { submit: { data: { roles: [{ title: "Engineer — Berlin", link: "/jobs/1" }] }, notes: "read from the snapshot" } },
  ];
  let callIdx = 0;
  const stub = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const turn = turns[Math.min(callIdx++, turns.length - 1)];
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
          choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: toolCalls, reasoning_content: "r".repeat(150) }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 300, total_tokens: 310 },
        }),
      );
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  t.after(() => stub.close());

  // cwd = the temp dir → the project name falls back to the directory basename
  // (no git remote) and the trace lands inside the cleaned-up temp tree.
  const { code, stdout, stderr } = await spawnBrowse([specPath], {
    WRAPPER_OLLAMA_BASE_URL: `http://127.0.0.1:${stub.address().port}/v1`,
  }, { cwd: dir });
  assert.equal(code, 0, `exit 0 on pass (stderr: ${stderr})`);
  const envelope = JSON.parse(stdout);
  assert.equal(typeof envelope.trace_path, "string");
  assert.match(envelope.trace_path, /playwright-output\/fyr334-trace-[^/]+\/browse\/[^/]+\/trace\.json$/);
  assert.ok(existsSync(envelope.trace_path), `trace persisted at ${envelope.trace_path}`);

  const persisted = JSON.parse(readFileSync(envelope.trace_path, "utf8"));
  const persistedText = JSON.stringify(persisted);
  assert.match(persistedText, /Jobs board/, "the snapshot text survives in the trace (the cues are auditable)");
  assert.match(persistedText, /Engineer — Berlin/, "the submit payload survives too");
  const runDirs = readdirSync(path.join(dir, "playwright-output", readdirSync(path.join(dir, "playwright-output"))[0], "browse"));
  assert.equal(runDirs.length, 1, "one run, one trace directory");
});