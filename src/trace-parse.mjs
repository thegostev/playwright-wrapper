// Trace-to-outcome parsing (FYR-331): the stock Playwright JSON report is the
// only ground truth a heal run trusts. Everything the heal loop needs is
// derived from the trace, never from a model claim (FYR-303: a self-report is
// a forgeable marker) and never from source locations (FYR-267: the JSON
// reporter only carries test.step entries, so the outermost failing
// `test.step('[sN] …')` node IS the failure address — verified by the FYR-330
// round-trip test).
//
// The test contract (FYR-250): Playwright's five statuses pass through
// UN-inferred; `outcome_class` is derived (pass | not_pass | no_verdict —
// only `not_pass` enters the heal loop); `error.stage` is derived
// (run | assert | compile). Unknown upstream statuses default to no_verdict,
// never an invented classification (the monotone invariant).

const STATUS_CLASS = {
  passed: 'pass',
  failed: 'not_pass',
  timedOut: 'not_pass',
  skipped: 'no_verdict',
  interrupted: 'no_verdict',
};

const STEP_TOKEN_RE = /^\[(s\d+)\]\s/;
const ENV_THROW_RE = /missing env var E2E_[A-Z0-9_]+/;
const LOAD_FAILURE_RE = /Cannot find module|SyntaxError|Unexpected token|failed to load|No tests found/;

/** Strip ANSI escapes — CI and Playwright both paint error text; records stay plain. */
export function stripAnsi(text) {
  return String(text ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\][^\x1b]*(\x1b\\|\x07)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}

/**
 * Parse the raw report bytes. Structural failures are loud and specific:
 * an unreadable report never reaches a model call (boundary validation).
 * Returns {ok, report} or {ok:false, problems}.
 */
export function parseTrace(jsonText) {
  const problems = [];
  if (typeof jsonText !== 'string' || jsonText.trim() === '') {
    return { ok: false, problems: ['results file is empty'] };
  }
  let report;
  try {
    report = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, problems: [`results file is not JSON: ${err.message.slice(0, 120)}`] };
  }
  if (typeof report !== 'object' || report === null || Array.isArray(report)) {
    return { ok: false, problems: ['results file is not a JSON object'] };
  }
  if (!Array.isArray(report.suites)) {
    problems.push('report has no suites[] — not a stock Playwright JSON report');
  }
  const version = report.config?.version;
  if (typeof version !== 'string' || !/^\d+\.\d+/.test(version)) {
    problems.push(
      `report has no readable Playwright version (config.version = ${JSON.stringify(version ?? null)}) — version coupling (FYR-249) requires a known version`,
    );
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, report };
}

/**
 * Walk a result's step tree depth-first, outermost first, and return the
 * first entry carrying an error whose title carries an [sN] token. Steps
 * without a token are skipped (internal API/expect steps never surface in
 * the report — verified), and an unexecuted step is simply absent.
 * Returns the step node or null.
 */
export function findFailingStep(steps) {
  for (const step of steps ?? []) {
    if (step.error && STEP_TOKEN_RE.test(step.title)) return step;
    const inner = findFailingStep(step.steps);
    if (inner) return inner;
  }
  return null;
}

/** All [sN] step titles present in the result, in execution order. */
export function attemptedStepIds(steps) {
  const ids = [];
  const walk = (nodes) => {
    for (const step of nodes ?? []) {
      const m = step.title?.match(STEP_TOKEN_RE);
      if (m) ids.push(m[1]);
      walk(step.steps);
    }
  };
  walk(steps);
  return ids;
}

/**
 * The locator the failure waited on, read from the error's call log:
 * `- waiting for getByRole('button', { name: 'Log in' })`. Returns the raw
 * waiting-for text, or null when the message names none.
 */
export function locatorFromError(errorMessage) {
  const m = String(errorMessage ?? '').match(/waiting for (\S.*)$/m);
  return m ? m[1].trim() : null;
}

/**
 * Derive the heal-relevant outcome from a parsed report for one spec/test.
 * The first failing test in the report is the heal target; when several fail
 * the caller is told (one ladder notch heals one spec).
 *
 * Returns:
 * {
 *   version, rootDir, specPath,       // where the failing spec lives
 *   status,                           // passed through, never inferred
 *   outcomeClass,                     // pass | not_pass | no_verdict
 *   errorStage,                       // 'run' | 'assert' | 'compile' | null
 *   failingStepId,                    // 'sN' | null
 *   failingStepTitle,
 *   failedLocator,                    // from the call log, may be null
 *   errorMessage,                     // ANSI-stripped
 *   attemptedIds,                     // every [sN] step the trace shows
 *   nFailingTests,                    // across the whole report
 * }
 */
export function deriveOutcome(report) {
  const version = report.config?.version;
  const rootDir = report.config?.rootDir ?? '';

  // Collect every test result with the spec that owns it.
  const entries = [];
  const walkSuites = (suites) => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        for (const t of spec.tests ?? []) {
          const result = t.results?.[t.results.length - 1];
          if (result) entries.push({ spec, result });
        }
      }
      walkSuites(suite.suites);
    }
  };
  walkSuites(report.suites);

  const failed = entries.filter(({ result }) => (STATUS_CLASS[result.status] ?? 'no_verdict') === 'not_pass');
  const target = failed[0] ?? entries[0] ?? null;

  if (!target) {
    return {
      version, rootDir,
      specPath: null,
      status: null,
      outcomeClass: 'no_verdict',
      errorStage: null,
      failingStepId: null,
      failingStepTitle: null,
      failedLocator: null,
      errorMessage: null,
      attemptedIds: [],
      nFailingTests: failed.length,
    };
  }

  const { spec, result } = target;
  const status = result.status;
  const outcomeClass = STATUS_CLASS[status] ?? 'no_verdict'; // unknown upstream → no_verdict, never invented

  const errorMessage = stripAnsi(
    [result.error?.message, ...(result.errors ?? []).map((e) => e?.message)].filter(Boolean).join('\n') ||
      '',
  ).trim();

  const failing = findFailingStep(result.steps);
  const attemptedIds = attemptedStepIds(result.steps);

  let errorStage = null;
  if (outcomeClass === 'not_pass') {
    if (failing) {
      // A locator-bearing assertion failure is an assert; an action error is a
      // run failure. The failing step's own error text is primary (the report
      // carries the same text at the result level, but the step node owns it).
      const failingMsg = stripAnsi(String(failing.error?.message ?? ''));
      errorStage = /\bexpect\(|toBe[A-Z]\w*\(/.test(`${failingMsg}\n${errorMessage}`) ? 'assert' : 'run';
    } else if (errorMessage) {
      // No step owns it: the spec failed at load (import error, module-top throw).
      errorStage = 'compile';
    }
  }

  const specPath =
    spec.file && rootDir ? `${rootDir.replace(/\/$/, '')}/${spec.file.replace(/^\//, '')}` : spec.file ?? null;

  return {
    version,
    rootDir,
    specPath,
    status,
    outcomeClass,
    errorStage,
    failingStepId: failing ? failing.title.match(STEP_TOKEN_RE)[1] : null,
    failingStepTitle: failing ? failing.title : null,
    failedLocator: errorMessage ? locatorFromError(errorMessage) : null,
    errorMessage,
    attemptedIds,
    nFailingTests: failed.length,
  };
}

/**
 * The Playwright version the report was produced with, as {major, minor, raw},
 * or null when unreadable (the caller refuses loudly on null).
 */
export function parseReportVersion(version) {
  if (typeof version !== 'string') return null;
  const m = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0), full: version };
}