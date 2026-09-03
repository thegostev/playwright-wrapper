// Task-spec parsing (FYR-329): the ONE input shape (FYR-251 resolution).
//
// One parser, one path: the task spec is a keyed-line header (closed schema)
// + a freeform NL body. The header carries `profile` (required, human-declared
// ∈ {test, browsing} — never model-routed) and `target` (the URL the wrapper
// drives). The body is the NL goal, verbatim. A `browse:` block nests
// `schema` (path to the expected JSON Schema file), `allowEmpty`,
// `identityQuestion` — and `browse:` with `profile: test` is an error
// (profile-conditional validation is one check, FYR-251 Q5).
//
// Nothing here repairs: a violation is a loud refusal with a line number.
//
//   parseTaskSpec(text)  — spec text -> {header, goal}
//   checkTaskSpec(text)  — parse + validate, {ok, spec} | {ok:false, problems[]}

export class TaskSpecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaskSpecError';
  }
}

const PROFILE_RE = /^profile:\s*(\S+)\s*$/;
const TARGET_RE = /^target:\s*(\S+)\s*$/;
const BROWSE_RE = /^browse:\s*$/;
const BROWSE_KEY_RE = /^\s+(schema|allowEmpty|identityQuestion):\s*(\S.*?)\s*$/;

function atLine(n, msg) {
  return `line ${n}: ${msg}`;
}

/**
 * Parse the task-spec format into {header, goal}.
 * Throws TaskParseRefusal on any violation (problems carry line numbers).
 *
 * Format (the one input shape, FYR-251):
 *
 *   profile: test          <- required, human-declared (test|browsing)
 *   target: <url>          <- required, the page the wrapper drives
 *
 *   <freeform NL goal: the flow the test should cover>
 *
 * A `browse:` block (browsing profile only) nests its keys on indented lines:
 *
 *   profile: browsing
 *   target: https://example.com/jobs
 *   browse:
 *     schema: ./expected.schema.json
 *     allowEmpty: false
 *     identityQuestion: is this the Fortum careers page?
 *
 *   <freeform NL goal>
 */
export function parseTaskSpec(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new TaskSpecRefusal(['task spec is empty — pass a spec file or inline text']);
  }
  if (/[^\x00-\x7F]/.test(text)) {
    // locate the offending line for the refusal
    const lines = text.split('\n');
    const bad = lines.findIndex((l) => /[^\x00-\x7F]/.test(l));
    throw new TaskSpecRefusal([atLine(bad + 1, 'non-ASCII character — task specs are ASCII-only')]);
  }

  const lines = text.split('\n');
  const problems = [];
  const header = { profile: null, target: null, browse: null };

  let i = 0;
  // Header: keyed lines until the first blank line (or EOF).
  let sawBlank = false;
  let bodyStart = -1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      if (sawBlank) continue; // skip leading blanks before header too
      sawBlank = true;
      bodyStart = i + 1;
      i += 1;
      break;
    }
    const m = line.match(/^(\S.*?):\s*(.*)$/);
    if (!m) {
      problems.push(atLine(i + 1, `expected "key: value" header line or a blank line ending the header — got "${line.slice(0, 60)}"`));
      continue;
    }
    const key = m[1];
    const value = m[2].trim();
    if (key === 'profile') {
      if (header.profile) problems.push(atLine(i + 1, 'duplicate profile: header key'));
      else if (value !== 'test' && value !== 'browsing') {
        problems.push(atLine(i + 1, `profile must be "test" or "browsing" (human-declared, no default) — got "${value}"`));
      } else header.profile = value;
    } else if (key === 'target') {
      if (header.target) problems.push(atLine(i + 1, 'duplicate target: header key'));
      else if (!/^https?:\/\//.test(value)) {
        problems.push(atLine(i + 1, `target must be an absolute http(s) URL — got "${value}"`));
      } else header.target = value;
    } else if (key === 'browse') {
      if (value !== '') {
        problems.push(atLine(i + 1, 'browse: opens a block — its keys are indented lines beneath it'));
      } else if (header.browse) {
        problems.push(atLine(i + 1, 'duplicate browse: block'));
      } else {
        header.browse = {};
        // consume indented browse keys
        let j = i + 1;
        for (; j < lines.length; j++) {
          const b = lines[j];
          if (b.trim() === '') break;
          if (!/^ / .test(b)) break; // unindented → header done
          const bm = b.match(/^\s+(\S.*?):\s*(.*)$/);
          if (!bm) {
            problems.push(atLine(j + 1, `expected "key: value" inside the browse: block — got "${b.trim().slice(0, 60)}"`));
            continue;
          }
          const bkey = bm[1];
          const bvalue = bm[2].trim();
          if (!['schema', 'allowEmpty', 'identityQuestion'].includes(bkey)) {
            problems.push(atLine(j + 1, `unknown browse: key "${bkey}" (allowed: schema, allowEmpty, identityQuestion)`));
          } else if (header.browse[bkey] !== undefined) {
            problems.push(atLine(j + 1, `duplicate browse.${bkey}`));
          } else {
            header.browse[bkey] = bvalue;
          }
        }
        i = j; // continue main scan at the unindented line / blank
        // if the browse block is followed by a blank line, that starts the body
        if (lines[i]?.trim() === '') {
          sawBlank = true;
          bodyStart = i + 1;
          i += 1;
          break;
        }
      }
    } else {
      problems.push(atLine(i + 1, `unknown header key "${key}" (allowed: profile, target, browse)`));
    }
  }

  if (!sawBlank) {
    // no blank line: everything was header; body missing
    bodyStart = lines.length;
  }

  // Profile-conditional validation: one check (FYR-251 Q5).
  if (header.profile === 'test' && header.browse) {
    problems.push('browse: block requires profile: browsing (profile: test stays bare)');
  }

  const goalLines = lines.slice(bodyStart).join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
  if (header.profile === null) {
    problems.push('header: profile is required (human-declared: test|browsing, no default)');
  }
  if (header.target === null) {
    problems.push('header: target is required (the absolute http(s) URL the wrapper drives)');
  }
  const goal = goalLines.trim();
  if (goal === '') {
    problems.push('body: the NL goal is required (what flow should the test cover)');
  }

  if (problems.length > 0) throw new TaskSpecRefusal(problems);
  return { header, goal };
}

export class TaskSpecRefusal extends Error {
  constructor(problems) {
    super(`task spec refused:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'TaskSpecRefusal';
    this.problems = problems;
  }
}

/**
 * checkTaskSpec: the boundary-validation form (like checkPlan). Returns
 * {ok: true, spec} or {ok: false, problems}. Never throws.
 */
export function checkTaskSpec(text) {
  try {
    return { ok: true, spec: parseTaskSpec(text) };
  } catch (err) {
    if (err instanceof TaskSpecRefusal) return { ok: false, problems: err.problems };
    throw err;
  }
}