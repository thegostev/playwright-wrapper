// FYR-334: browse-oracle unit tests — the part of the verdict the model
// cannot forge. Pure module: cue scanning, empty three-state, the judge
// contract, override precedence, and normative presence validation.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanMarker,
  isEmptyPayload,
  schemaMinItems,
  classifyEmpty,
  parsePagerProgress,
  parseStatedTotal,
  nextLinksFromSnapshot,
  scanCues,
  paginationGate,
  rowsExtracted,
  coverageSuspect,
  runIdentityJudge,
  applyOverrides,
  validateEnvelope,
} from "../src/browse-oracle.mjs";

// --- Empty handling -----------------------------------------------------------

test("scanMarker: the negative-marker list matches case-insensitively", () => {
  assert.deepEqual(scanMarker("Sorry — No Open Positions right now"), { found: true, text: "no open positions" });
  assert.deepEqual(scanMarker("0 results matched your filter"), { found: true, text: "0 results" });
  assert.deepEqual(scanMarker("12 open roles, apply by Friday"), { found: false, text: null });
  assert.deepEqual(scanMarker(""), { found: false, text: null });
});

test("isEmptyPayload: null, [], and all-empty objects are empty; scalars are not", () => {
  assert.equal(isEmptyPayload(null), true);
  assert.equal(isEmptyPayload([]), true);
  assert.equal(isEmptyPayload({ roles: [] }), true);
  assert.equal(isEmptyPayload({ roles: [], meta: null }), true);
  assert.equal(isEmptyPayload({ roles: [{ title: "x" }] }), false);
  assert.equal(isEmptyPayload("no roles"), false);
  assert.equal(isEmptyPayload(0), false);
});

test("schemaMinItems: the strictest declared minItems, anywhere in the schema", () => {
  assert.equal(schemaMinItems({ type: "array", minItems: 3 }), 3);
  assert.equal(
    schemaMinItems({
      type: "object",
      properties: { roles: { type: "array", minItems: 2, items: { type: "object", properties: { tags: { type: "array", minItems: 5 } } } } },
    }),
    5,
  );
  assert.equal(schemaMinItems({ type: "object", properties: { name: { type: "string" } } }), 0);
  assert.equal(schemaMinItems(null), 0);
});

test("classifyEmpty: marker + allowEmpty → empty_confirmed (pass, no recheck needed)", () => {
  const v = classifyEmpty({ allowEmpty: true, schema: null, marker: { found: true, text: "no open positions" } });
  assert.equal(v.outcome, "empty_confirmed");
  assert.deepEqual(v.empty, { marker_found: true, marker_text: "no open positions", recheck_attempted: false });
});

test("classifyEmpty: minItems is an ABSOLUTE floor — marker never overrides it (empty_schema_conflict)", () => {
  const schema = { type: "object", properties: { roles: { type: "array", minItems: 1 } }, required: ["roles"] };
  const v = classifyEmpty({ allowEmpty: false, schema, marker: { found: true, text: "no open roles" } });
  assert.equal(v.outcome, "empty_schema_conflict");
  assert.ok(v.empty.marker_found);
  assert.ok(v.schema.failed_fields.length >= 1, "schema block present (marker-vs-contract contradiction)");
});

test("classifyEmpty: schema minItems: 0 declares empty tolerance like allowEmpty", () => {
  const v = classifyEmpty({
    allowEmpty: false,
    schema: { type: "array", minItems: 0 },
    marker: { found: true, text: "0 results" },
  });
  assert.equal(v.outcome, "empty_confirmed");
});

test("classifyEmpty: no marker → one fixed recheck; marker appears → confirmed (recheck_attempted)", () => {
  const v = classifyEmpty({ allowEmpty: true, schema: null, marker: { found: false, text: null }, recheck: { found: true, text: "no jobs" } });
  assert.equal(v.outcome, "empty_confirmed");
  assert.equal(v.empty.recheck_attempted, true);
});

test("classifyEmpty: no marker before or after the recheck → empty_unconfirmed (never auto-pass)", () => {
  const v = classifyEmpty({ allowEmpty: true, schema: null, marker: { found: false, text: null }, recheck: { found: false, text: null } });
  assert.equal(v.outcome, "empty_unconfirmed");
});

test("classifyEmpty: marker + allowEmpty still never overrides a minItems floor (empty_schema_conflict)", () => {
  const v = classifyEmpty({
    allowEmpty: true,
    schema: { type: "object", properties: { roles: { type: "array", minItems: 3 } }, required: ["roles"] },
    marker: { found: true, text: "no open roles" },
  });
  assert.equal(v.outcome, "empty_schema_conflict");
});

// --- Cue scanner ---------------------------------------------------------------

test("parsePagerProgress: page-progress forms parse; row totals are a different cue", () => {
  assert.deepEqual(parsePagerProgress("Page 3 of 10"), [{ k: 3, n: 10 }]);
  assert.deepEqual(parsePagerProgress("Showing 2 of 5 pages"), [{ k: 2, n: 5 }]);
  assert.deepEqual(parsePagerProgress("Results 1–18 of 18"), [], "a row total is not pager progress");
  assert.deepEqual(parsePagerProgress("no pager here"), []);
});

test("parseStatedTotal: the ROW total, harness-parsed; absent → null", () => {
  assert.equal(parseStatedTotal("Results 1–18 of 18"), 18);
  assert.equal(parseStatedTotal("of 66 jobs"), 66);
  assert.equal(parseStatedTotal("1 - 10 of 42 results"), 42);
  assert.equal(parseStatedTotal("12 open roles"), null);
});

test("nextLinksFromSnapshot: a live Next is a link; a text-downgraded Next is not", () => {
  const live = `- link "Next" [ref=e9]
  - /url: /?page=2`;
  assert.deepEqual(nextLinksFromSnapshot(live), [{ ref: "e9", label: "Next" }]);
  const downgraded = `- text "Next" [ref=e9]`;
  assert.deepEqual(nextLinksFromSnapshot(downgraded), []);
  assert.deepEqual(nextLinksFromSnapshot("- link \"Next page »\" [ref=e2]")[0].ref, "e2");
});

const snap = (page, n, withNext) => {
  const next = withNext ? `\n- link "Next" [ref=e9]\n  - /url: /?page=${page + 1}` : "";
  return `- heading "Jobs" [ref=e1]\n- paragraph "Page ${page} of ${n}" [ref=e2]${next}`;
};

test("scanCues: every pager parse is collected; the freshest snapshot is tracked", () => {
  const cues = scanCues([
    { tool: "browser_snapshot", text: snap(1, 3, true) },
    { tool: "browser_click", ok: true, target: "e9", element: "Next" },
    { tool: "browser_snapshot", text: snap(2, 3, true) },
  ]);
  assert.deepEqual(
    cues.pagerParses.map(({ k, n }) => ({ k, n })),
    [
      { k: 1, n: 3 },
      { k: 2, n: 3 },
    ],
  );
  assert.ok(cues.lastSnapshot.includes("Page 2 of 3"));
  assert.equal(cues.followedNext.length, 1, "the click on the Next ref is a followed Next");
});

test("scanCues: present-but-unused Next is NOT a cue", () => {
  const cues = scanCues([{ tool: "browser_snapshot", text: snap(1, 3, true) }]);
  assert.equal(cues.pagerParses.length, 1);
  assert.equal(cues.followedNext.length, 0, "nobody followed it");
});

test("scanCues: a click that errored is not a followed Next", () => {
  const cues = scanCues([
    { tool: "browser_snapshot", text: snap(1, 3, true) },
    { tool: "browser_click", ok: false, error: "timed out", target: "e9", element: "Next" },
  ]);
  assert.equal(cues.followedNext.length, 0);
});

test("paginationGate: k < n fires; k == n with no live Next does not; contradictions fire", () => {
  // freshest k < n fires
  const early = scanCues([{ tool: "browser_snapshot", text: snap(1, 3, true) }]);
  assert.equal(paginationGate(early).fired, true);

  // completed pager: freshest k == n, terminal snapshot has no Next
  const done = scanCues([
    { tool: "browser_snapshot", text: snap(1, 2, true) },
    { tool: "browser_click", ok: true, target: "e9", element: "Next" },
    { tool: "browser_snapshot", text: snap(2, 2, false) },
  ]);
  const doneGate = paginationGate(done);
  assert.equal(doneGate.fired, false);

  // contradictory: k == n parsed but a live Next survives on the terminal snapshot
  const contradiction = scanCues([
    { tool: "browser_snapshot", text: snap(2, 2, false) + "\n- link \"Next\" [ref=e99]\n  - /url: /?page=3" },
  ]);
  assert.equal(paginationGate(contradiction).fired, true, "union semantics: contradictory cues fire");
});

test("paginationGate: an unclassified run stays telemetry-only; unparseable terminal evidence fails open", () => {
  // present-but-unused Next alone: no pager parse, no follow → not eligible
  const unused = scanCues([
    { tool: "browser_snapshot", text: '- heading "Jobs" [ref=e1]\n- link "Next" [ref=e9]\n  - /url: /?page=2' },
  ]);
  const unusedGate = paginationGate(unused);
  assert.equal(unusedGate.fired, false, "a Next the model never used is telemetry, not a verdict");
  assert.equal(unusedGate.pagination.terminal_evidence.parseable, true);

  // no snapshot evidence at all → fail-open
  const noEvidence = scanCues([{ tool: "browser_click", ok: true, target: "e1", element: "thing" }]);
  const g = paginationGate(noEvidence);
  assert.equal(g.fired, false);
  assert.equal(g.pagination.terminal_evidence.parseable, false, "the diagnostic names the fail-open");
});

test("paginationGate: pagination block carries class_evidence + terminal_evidence (required-iff shape)", () => {
  const cues = scanCues([
    { tool: "browser_snapshot", text: snap(1, 2, true) },
    { tool: "browser_click", ok: true, target: "e9", element: "Next" },
    { tool: "browser_snapshot", text: snap(2, 2, false) + "\n- link \"Next\" [ref=e19]\n  - /url: /?page=3" },
  ]);
  const { fired, pagination } = paginationGate(cues);
  assert.equal(fired, true);
  assert.ok(pagination.class_evidence.pager_parse, "k of n parse in class evidence");
  assert.equal(pagination.class_evidence.followed_next.length, 1);
  assert.equal(pagination.terminal_evidence.live_next.length, 1);
});

// --- Coverage telemetry (FYR-265 fix) -------------------------------------------

test("rowsExtracted: the payload's primary array length; no array shape → null", () => {
  assert.equal(rowsExtracted([1, 2, 3]), 3);
  assert.equal(rowsExtracted({ roles: [1, 2] }), 2);
  assert.equal(rowsExtracted("text"), null);
  assert.equal(rowsExtracted({ a: 1 }), null);
});

test("coverageSuspect: 0.9 threshold on the PARSED total only; absent total → no arithmetic; not_pass never upgraded", () => {
  assert.equal(coverageSuspect({ outcome_class: "pass", rows: 10, statedTotalParsed: 20 }), true);
  assert.equal(coverageSuspect({ outcome_class: "pass", rows: 19, statedTotalParsed: 20 }), false);
  assert.equal(coverageSuspect({ outcome_class: "pass", rows: 10, statedTotalParsed: null }), false, "absent total = no signal");
  assert.equal(coverageSuspect({ outcome_class: "not_pass", rows: 1, statedTotalParsed: 20 }), false);
});

// --- Identity judge --------------------------------------------------------------

test("runIdentityJudge: pass carries no reason; rejection carries one; confidence is recorded, never routing", async () => {
  const pass = await runIdentityJudge({ question: "is this the jobs page?", url: "https://x", snapshotText: "- heading Jobs", judge: async () => ({ pass: true, confidence: 0.9 }) });
  assert.deepEqual(pass, { question: "is this the jobs page?", ran: true, pass: true, confidence: 0.9 });

  const reject = await runIdentityJudge({ question: "q", url: "u", snapshotText: "s", judge: async () => ({ pass: false, reason: "this is the pricing page" }) });
  assert.equal(reject.ran, true);
  assert.equal(reject.pass, false);
  assert.equal(reject.reason, "this is the pricing page");
});

test("runIdentityJudge: a judge error NEVER overrides — ran:false + error, structural stands", async () => {
  const out = await runIdentityJudge({ question: "q", url: "u", snapshotText: "s", judge: async () => { throw new Error("judge timeout"); } });
  assert.equal(out.ran, false);
  assert.match(out.error, /judge timeout/);
});

// --- Override precedence ----------------------------------------------------------

test("applyOverrides: coverage_incomplete > semantic_rejected > coverage_suspect > structural", () => {
  const structural = { structuralOutcome: "verified", structuralClass: "pass" };
  const rejectJudge = { ran: true, pass: false, reason: "wrong page" };

  const gateWins = applyOverrides({ ...structural, judge: rejectJudge, pagination: { fired: true, pagination: { class_evidence: {}, terminal_evidence: {} } } });
  assert.equal(gateWins.outcome, "coverage_incomplete");
  assert.equal(gateWins.outcome_class, "not_pass");

  const judgeWins = applyOverrides({ ...structural, judge: rejectJudge, pagination: { fired: false, pagination: null }, suspect: true });
  assert.equal(judgeWins.outcome, "semantic_rejected");

  const suspectWins = applyOverrides({ ...structural, judge: { ran: true, pass: true }, pagination: { fired: false, pagination: null }, suspect: true });
  assert.equal(suspectWins.outcome, "coverage_suspect");
  assert.equal(suspectWins.outcome_class, "pass_with_warning");

  const structuralStands = applyOverrides({ ...structural, judge: { ran: false, error: "e" }, pagination: { fired: false, pagination: null } });
  assert.equal(structuralStands.outcome, "verified");
  assert.equal(structuralStands.semantic.ran, false, "semantic present whenever the judge ran (base-rate)");
});

// --- Normative presence validation -------------------------------------------------

const BASE = {
  contract_version: 2,
  task_id: null,
  url: "https://example.test/",
  attempts: { n_primary: 1, n_fallback: 0, third_tier: { attempted: false, used: false } },
  outcome_history: [],
  escalation: null,
  semantic: null,
  pagination: null,
  coverage: { rows_extracted: null, last_page_reached_reported: null, stated_total_reported: null, stated_total_parsed: null, stated_total_disagreement: null },
  error: null,
  data: null,
  notes: "",
  trace: [],
  trace_path: null,
};

const env = (over) => ({ ...BASE, ...over });

test("validateEnvelope: every one of the twelve outcomes ships a valid envelope", () => {
  const cases = [
    { outcome: "verified", structural_outcome: "verified", outcome_class: "pass", data: { a: 1 } },
    { outcome: "empty_confirmed", structural_outcome: "empty_confirmed", outcome_class: "pass", empty: { marker_found: true, marker_text: "no roles", recheck_attempted: false } },
    { outcome: "asserted", structural_outcome: "asserted", outcome_class: "pass_with_warning", data: { a: 1 } },
    { outcome: "coverage_suspect", structural_outcome: "verified", outcome_class: "pass_with_warning", data: { a: 1 } },
    { outcome: "coverage_incomplete", structural_outcome: "verified", outcome_class: "not_pass", pagination: { class_evidence: {}, terminal_evidence: {} } },
    { outcome: "empty_unconfirmed", structural_outcome: "empty_unconfirmed", outcome_class: "not_pass", empty: { marker_found: false, marker_text: null, recheck_attempted: true } },
    {
      outcome: "empty_schema_conflict",
      structural_outcome: "empty_schema_conflict",
      outcome_class: "not_pass",
      empty: { marker_found: true, marker_text: "no roles", recheck_attempted: false },
      schema: { failed_fields: [] },
    },
    { outcome: "schema_failed", structural_outcome: "schema_failed", outcome_class: "not_pass", schema: { failed_fields: [] } },
    { outcome: "semantic_rejected", structural_outcome: "verified", outcome_class: "not_pass", semantic: { question: "q", ran: true, pass: false, reason: "r" } },
    { outcome: "no_terminal_call", structural_outcome: "no_terminal_call", outcome_class: "not_pass", error: { stage: "submit", tool: null, message: "m" } },
    { outcome: "tool_error", structural_outcome: "tool_error", outcome_class: "not_pass", error: { stage: "recheck", tool: null, message: "m" } },
    { outcome: "malformed_submit", structural_outcome: "malformed_submit", outcome_class: "not_pass", error: { stage: "submit", tool: "submit_extraction", message: "m" } },
  ];
  for (const c of cases) {
    assert.deepEqual(validateEnvelope(env(c)), [], `outcome ${c.outcome} must validate`);
  }
});

test("validateEnvelope: presence violations are loud and specific", () => {
  assert.match(
    validateEnvelope(env({ outcome: "empty_unconfirmed", structural_outcome: "empty_unconfirmed", outcome_class: "not_pass" })).join(" "),
    /empty block REQUIRED/,
  );
  assert.match(
    validateEnvelope(env({ outcome: "verified", structural_outcome: "verified", outcome_class: "pass", schema: { failed_fields: [] } })).join(" "),
    /schema block present but structural_outcome is verified/,
  );
  assert.match(
    validateEnvelope(env({ outcome: "no_terminal_call", structural_outcome: "no_terminal_call", outcome_class: "not_pass" })).join(" "),
    /error block REQUIRED/,
  );
  assert.match(
    validateEnvelope(env({ outcome: "semantic_rejected", structural_outcome: "verified", outcome_class: "not_pass", semantic: { ran: false, error: "judge died" } })).join(" "),
    /a judge error never overrides/,
  );
  assert.match(
    validateEnvelope(env({ outcome: "coverage_incomplete", structural_outcome: "verified", outcome_class: "not_pass" })).join(" "),
    /pagination block REQUIRED/,
  );
  assert.match(
    validateEnvelope(env({ outcome: "verified", structural_outcome: "verified", outcome_class: "pass", pagination: { class_evidence: {}, terminal_evidence: {} } })).join(" "),
    /pagination block present but outcome is verified/,
  );
});

test("validateEnvelope: the _reported suffix is the guard — unsuffixed model fields are refused", () => {
  assert.match(
    validateEnvelope(env({ ...BASE, coverage: { rows_extracted: 1, stated_total: 66, last_page_reached: 3, stated_total_parsed: null } })).join(" "),
    /unsuffixed model-authored fields/,
  );
  const missingTwins = { ...BASE.coverage };
  delete missingTwins.stated_total_parsed;
  assert.match(validateEnvelope(env({ coverage: missingTwins })).join(" "), /stated_total_parsed always present/);
});

test("validateEnvelope: class table and structural-outcome integrity", () => {
  assert.match(validateEnvelope(env({ outcome: "verified", structural_outcome: "verified", outcome_class: "not_pass" })).join(" "), /outcome_class/);
  assert.match(validateEnvelope(env({ outcome: "verified", structural_outcome: "schema_failed", outcome_class: "pass" })).join(" "), /must equal outcome/);
  assert.match(validateEnvelope(env({ outcome: "bogus_outcome", structural_outcome: "bogus_outcome", outcome_class: "not_pass" })).join(" "), /unknown outcome/);
  assert.match(validateEnvelope(env({ ...BASE, contract_version: 1, outcome: "verified", structural_outcome: "verified", outcome_class: "pass" })).join(" "), /contract_version/);
  assert.match(validateEnvelope(env({ ...BASE, coverage: undefined, outcome: "verified", structural_outcome: "verified", outcome_class: "pass" })).join(" "), /coverage block ALWAYS present/);
});