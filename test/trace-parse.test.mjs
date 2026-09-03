// FYR-331: trace-to-outcome parsing tests (src/trace-parse.mjs).
//
// The report shapes here are the FYR-330-probed ground truth: stock Playwright
// JSON reporter output — suites → specs → tests → results[last], error text
// ANSI-painted, steps carrying ONLY test.step('[sN] …') entries. Everything
// the heal loop consumes (address, stage, class) is derived from this shape,
// never from a model claim and never from source locations.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  stripAnsi, parseTrace, findFailingStep, attemptedStepIds,
  locatorFromError, deriveOutcome, parseReportVersion,
} from "../src/trace-parse.mjs";

const PW_VERSION = "1.63.0";

// ANSI-painted failure the probe observed (click timeout waiting on a locator).
const WAIT_MSG =
  "\x1b[31mTimeoutError: page.click: Timeout 1500ms exceeded.\x1b[0m" +
  "\nCall log:\n  \x1b[2m- waiting for getByRole('button', { name: 'Log in' })\x1b[22m";
const WAIT_MSG_STRIPPED = WAIT_MSG.replace(/\x1b\[[0-9;]*m/g, "");

const STEP_TREE = [
  { title: "[s1] go to the login page", steps: [] },
  { title: "[s2] fill the email field", steps: [] },
  { title: "[s3] fill the password field", steps: [] },
  { title: "[s4] submit the form", error: { message: WAIT_MSG }, steps: [] },
];

/** Minimal stock-report shape; only what parseTrace/deriveOutcome read. */
function report({
  version = PW_VERSION,
  rootDir = "/repo",
  file = "tests/user-can-sign-in.spec.ts",
  status = "failed",
  error = WAIT_MSG, // the probe showed the failure text at the result level too
  steps = STEP_TREE,
  extraSpecs = [],
  specCount = 1,
} = {}) {
  const specs = [];
  for (let i = 0; i < specCount; i++) {
    const first = i === 0;
    specs.push({
      title: `user can sign in${i > 0 ? ` ${i}` : ""}`,
      file: first ? file : `tests/other-${i}.spec.ts`,
      tests: [{
        results: [{
          status: first ? status : "failed",
          error: first
            ? (error == null ? null : typeof error === "string" ? { message: error } : error)
            : { message: "boom" },
          errors: [],
          steps: first ? steps : [],
        }],
      }],
    });
  }
  specs.push(...extraSpecs);
  return { config: { version, rootDir }, suites: [{ title: "", file: "", specs }] };
}

// ------------------------------------------------------------------ stripAnsi

test("stripAnsi removes SGR and OSC sequences", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m plain"), "red plain");
  assert.equal(stripAnsi("\x1b[2m- waiting for getByRole('x')\x1b[22m"), "- waiting for getByRole('x')");
  assert.equal(stripAnsi(null), "");
});

// ----------------------------------------------------------------- parseTrace

test("parseTrace accepts a stock-shaped report", () => {
  const res = parseTrace(JSON.stringify(report()));
  assert.equal(res.ok, true);
  assert.equal(res.report.config.version, PW_VERSION);
});

test("parseTrace refuses empty and non-JSON bytes loudly", () => {
  assert.match(parseTrace("").problems.join(" "), /results file is empty/);
  assert.match(parseTrace("not json at all {").problems.join(" "), /results file is not JSON/);
});

test("parseTrace refuses a report with no suites[]", () => {
  const res = parseTrace(JSON.stringify({ config: { version: PW_VERSION } }));
  assert.equal(res.ok, false);
  assert.match(res.problems.join(" "), /no suites\[\]/);
});

test("parseTrace refuses a report with no readable version (FYR-249 coupling)", () => {
  const rep = report();
  delete rep.config.version;
  const res = parseTrace(JSON.stringify(rep));
  assert.equal(res.ok, false);
  assert.match(res.problems.join(" "), /no readable Playwright version/);
});

// ------------------------------------------------------------ locatorFromError

test("locatorFromError reads the waiting-for call-log line", () => {
  assert.equal(
    locatorFromError(WAIT_MSG_STRIPPED),
    "getByRole('button', { name: 'Log in' })",
  );
});

test("locatorFromError returns null when the message names no locator", () => {
  assert.equal(locatorFromError("Error: something else happened"), null);
});

// ------------------------------------------------------------ findFailingStep

test("findFailingStep walks depth-first, outermost first, [sN] titles only", () => {
  const tree = [
    { title: "[s1] go to the login page", steps: [] },
    {
      title: "[s2] fill the email field",
      steps: [{ title: "expect.toBeVisible", error: { message: "inner non-step error" } }],
    },
    { title: "[s4] submit the form", error: { message: WAIT_MSG }, steps: [] },
  ];
  const step = findFailingStep(tree);
  assert.equal(step.title.match(/^\[(s\d+)\]/)[1], "s4");
  // A step WITHOUT the token never counts, even with an error.
  const noToken = findFailingStep([{ title: "internal api step", error: { message: "x" } }]);
  assert.equal(noToken, null);
});

test("attemptedStepIds lists every [sN] the trace shows, in order", () => {
  assert.deepEqual(attemptedStepIds(STEP_TREE), ["s1", "s2", "s3", "s4"]);
  assert.deepEqual(attemptedStepIds([]), []);
});

// -------------------------------------------------------------- deriveOutcome

test("deriveOutcome: failed run derives not_pass + run stage + the s4 address", () => {
  const o = deriveOutcome(report());
  assert.equal(o.version, PW_VERSION);
  assert.equal(o.status, "failed");
  assert.equal(o.outcomeClass, "not_pass");
  assert.equal(o.errorStage, "run");
  assert.equal(o.failingStepId, "s4");
  assert.equal(o.failedLocator, "getByRole('button', { name: 'Log in' })");
  assert.deepEqual(o.attemptedIds, ["s1", "s2", "s3", "s4"]);
  assert.equal(o.nFailingTests, 1);
  assert.equal(o.specPath, "/repo/tests/user-can-sign-in.spec.ts");
  assert.match(o.errorMessage, /TimeoutError: page\.click/);
  assert.ok(!o.errorMessage.includes("\x1b"), "error text is ANSI-stripped");
});

test("deriveOutcome: an assertion failure derives the assert stage", () => {
  const assertMsg = `Error: expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible() failed`;
  const steps = [
    { title: "[s1] go to the login page", steps: [] },
    { title: "[s5] assert the dashboard heading is shown", error: { message: assertMsg }, steps: [] },
  ];
  // Playwright surfaces the expect failure at the result level too.
  const o = deriveOutcome(report({ steps, error: assertMsg }));
  assert.equal(o.errorStage, "assert");
  assert.equal(o.failingStepId, "s5");
  // ...but the stage is derived from the failing STEP's error even when only
  // the step node carries it.
  const o2 = deriveOutcome(report({ steps, error: null }));
  assert.equal(o2.errorStage, "assert");
});

test("deriveOutcome: a spec that never ran derives the compile stage", () => {
  const o = deriveOutcome(report({ steps: [], error: { message: "Error: Cannot find module './missing'" } }));
  assert.equal(o.outcomeClass, "not_pass");
  assert.equal(o.errorStage, "compile");
  assert.equal(o.failingStepId, null);
});

test("deriveOutcome: passed is pass; no error stage", () => {
  const passedSteps = [{ title: "[s1] go to the login page", steps: [] }];
  const o = deriveOutcome(report({ status: "passed", error: null, steps: passedSteps }));
  assert.equal(o.outcomeClass, "pass");
  assert.equal(o.errorStage, null);
  assert.equal(o.failingStepId, null);
});

test("deriveOutcome: the five statuses pass through un-inferred", () => {
  assert.equal(deriveOutcome(report({ status: "timedOut" })).outcomeClass, "not_pass");
  assert.equal(deriveOutcome(report({ status: "timedOut" })).status, "timedOut");
  assert.equal(deriveOutcome(report({ status: "skipped", error: null })).outcomeClass, "no_verdict");
  assert.equal(deriveOutcome(report({ status: "interrupted", error: null })).outcomeClass, "no_verdict");
  // Unknown upstream status → no_verdict, never an invented classification.
  assert.equal(deriveOutcome(report({ status: "weirdFutureStatus", error: null })).outcomeClass, "no_verdict");
});

test("deriveOutcome: counts failing tests across the whole report", () => {
  const o = deriveOutcome(report({ specCount: 3 }));
  assert.equal(o.nFailingTests, 3);
});

test("deriveOutcome: no entries at all is no_verdict, never invented", () => {
  const rep = { config: { version: PW_VERSION, rootDir: "/repo" }, suites: [] };
  const o = deriveOutcome(rep);
  assert.equal(o.outcomeClass, "no_verdict");
  assert.equal(o.specPath, null);
});

// --------------------------------------------------------- parseReportVersion

test("parseReportVersion reads major/minor/patch; garbage is null", () => {
  assert.deepEqual(parseReportVersion("1.63.0"), { major: 1, minor: 63, patch: 0, full: "1.63.0" });
  assert.equal(parseReportVersion("1.63.0-alpha-2026-08-05").major, 1);
  assert.equal(parseReportVersion("banana"), null);
  assert.equal(parseReportVersion(undefined), null);
});