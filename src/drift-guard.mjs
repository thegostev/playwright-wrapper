// Drift guard (FYR-302).
//
// Heal refuses to patch a CI report produced at a commit other than the local
// checkout's HEAD. A report is the state of the app *at that commit*; patching
// a locator from a three-week-old report against the current working tree is
// healing a moved target, and the patch will look successful. FYR-249's "no
// healability promise at 90 days" is a disclaimer; this turns it into a check.
//
// The report's commit SHA is read from the heal run-id folder name
// (`YYYY-MM-DDTHHmmssZ-<sha7>`, per the FYR-251 placement rule) — the guard
// never opens a file to get it. It compares that SHA to local HEAD.
//
// Refusal messages state the mismatch and never name the bypass flag
// (`--drift-ok=<sha>`). FYR-252 makes the skill model-invoked, so Claude is
// the one deciding whether to retry with an override — a refusal that names
// its own bypass is the obvious next token, and will be appended. The override
// is value-bearing: it must name the report's exact SHA, and it fails if the
// report's SHA changes underneath it.

import { execFileSync } from 'node:child_process';

const RUN_ID_RE =
  /^\d{4}-\d{2}-\d{2}T\d{6}Z-([0-9a-f]{7})$/i;
const SHA7_RE = /^[0-9a-f]{7}$/i;
const SHA40_RE = /^[0-9a-f]{40}$/i;

// Full commit SHA -> the 7-char form that lands in a run-id folder name.
// Throws when the value is not a full SHA.
export function sha7(commitSha) {
  if (!SHA40_RE.test(String(commitSha))) {
    throw new Error(`not a full commit SHA: ${commitSha}`);
  }
  return String(commitSha).slice(0, 7).toLowerCase();
}

// The 7-char SHA out of a run-id folder name, read without opening anything.
// Returns the lowercased sha7, or null when the name is not a valid run-id.
export function extractShaFromRunId(runId) {
  if (typeof runId !== 'string') return null;
  const m = runId.trim().match(RUN_ID_RE);
  return m ? m[1].toLowerCase() : null;
}

// Accept the 7-char or full 40-char hex form of a commit SHA (the shapes an
// override can carry), normalized to the 7-char form used in run-id names.
// Throws when the value is not a SHA at all.
export function normalizeSha(value) {
  const v = String(value).trim();
  if (SHA7_RE.test(v)) return v.toLowerCase();
  if (SHA40_RE.test(v)) return v.slice(0, 7).toLowerCase();
  throw new Error(`not a commit SHA (7 or 40 hex digits): ${value}`);
}

// The checkout's HEAD commit, resolved from cwd. Throws with a `.reason` of
// 'not_git' (cwd is outside any repo) or 'no_head' (empty repo / no HEAD).
export function localHeadSha(cwd = process.cwd()) {
  let stderr = '';
  try {
    const stdout = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const head = stdout.trim();
    if (!SHA40_RE.test(head)) {
      throw Object.assign(
        new Error(`unexpected HEAD value from git rev-parse: ${head}`),
        { reason: 'no_head' },
      );
    }
    return head;
  } catch (err) {
    if (err && err.reason) throw err; // the unexpected-value throw above
    stderr = String(err?.stderr ?? '');
    const reason = stderr.includes('not a git repository') ? 'not_git' : 'no_head';
    throw Object.assign(
      new Error(`git rev-parse HEAD failed: ${stderr.trim() || 'no HEAD'}`),
      { reason },
    );
  }
}

// The verdict, pure: run SHA vs HEAD, with an optional override pin.
//   {ok:true, note:'match'}      run == HEAD
//   {ok:true, note:'override'}   run != HEAD, override names this run's SHA
//   {ok:false, reason:'drift'}            run != HEAD, no matching override
//   {ok:false, reason:'invalid_override'} override present but not a SHA
// runSha is the 7-hex form from the run-id; headSha is the full local HEAD.
export function verdict({ runSha, headSha, override }) {
  const headShort = headSha.slice(0, 7).toLowerCase();
  if (runSha === headShort) return { ok: true, note: 'match' };
  if (override === undefined || override === null) {
    return { ok: false, reason: 'drift' };
  }
  let pinned;
  try {
    pinned = normalizeSha(override);
  } catch {
    return { ok: false, reason: 'invalid_override' };
  }
  return pinned === runSha
    ? { ok: true, note: 'override' }
    : { ok: false, reason: 'drift' };
}

// The refusal text. States the mismatch; never names the bypass flag.
export function refusalMessage(reason, ctx = {}) {
  const { runSha, headSha, override } = ctx;
  switch (reason) {
    case 'unreadable_sha':
      return `refusing to heal: no commit SHA in the run id (expected format YYYY-MM-DDTHHmmssZ-<7-hex-sha>)`;
    case 'not_git':
      return `refusing to heal: not inside a git repository, so this checkout's HEAD commit cannot be determined`;
    case 'no_head':
      return `refusing to heal: cannot determine this checkout's HEAD commit (no commits yet?)`;
    case 'invalid_override':
      return `refusing to heal: the supplied SHA (${override}) is not a valid commit SHA (7 or 40 hex digits)`;
    case 'drift':
      return `refusing to heal: this run's commit ${runSha} does not match the local checkout's HEAD ${headSha.slice(0, 7)} — the report was produced from a different commit than the working tree`;
    default:
      throw new Error(`unknown refusal reason: ${reason}`);
  }
}

// The one-call drift check a heal run performs before any work.
// `run` is a run-id folder name, or a path to the run folder (the basename is
// the run-id). Returns {ok:true} or {ok:false, reason, message}.
export function checkRunDrift({ run, cwd = process.cwd(), override }) {
  const runId = String(run).split(/[\\/]/).pop();
  const runSha = extractShaFromRunId(runId);
  if (runSha === null) {
    return {
      ok: false,
      reason: 'unreadable_sha',
      message: refusalMessage('unreadable_sha'),
    };
  }
  let headSha;
  try {
    headSha = localHeadSha(cwd);
  } catch (err) {
    const reason = err.reason ?? 'no_head';
    return { ok: false, reason, message: refusalMessage(reason) };
  }
  const v = verdict({ runSha, headSha, override });
  if (v.ok) return { ok: true, note: v.note, runSha, headSha };
  return {
    ok: false,
    reason: v.reason,
    message: refusalMessage(v.reason, { runSha, headSha, override }),
  };
}
