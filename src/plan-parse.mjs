// Plan parsing, boundary validation, and generated-spec lint (FYR-267).
//
// The stamped pair (.plan.md + .spec.ts, FYR-268) is the generator's output
// contract. This module checks that contract mechanically, before any model
// call (the FYR-251 boundary-validation standing rule). Nothing here repairs:
// a violation is a loud refusal with a line number, never a rewrite.
//
// Three surfaces, one grammar module so a rule changed once changes everywhere:
//
//   parsePlan(text)    — keyed-line plan format -> {header, steps}
//   validatePlan(plan) — plan-level boundary validation (schema, ids, actions,
//                        locator slot grammar, value/expect forms, env names)
//   lintSpec(source)   — generated-spec lint (step tokens, locator slot
//                        grammar on emitted lines, one-line slots, the
//                        expect.soft/timeout/storageState denials, env guards)
//
// The locator slot grammar (Q12) is deliberately regex-checkable: every
// argument is a string/number literal or one of three literal option objects,
// so no parser is needed here, at the gate, or in the heal patcher.

const STEP_TOKEN_RE = /^\[(s\d+)\]\s/;
const ID_RE = /^s(\d+)$/;
const ENV_NAME_RE = /^E2E_[A-Z0-9_]+$/;
const FILE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// ARIA roles, for getByRole's first argument. The complete abstract-free set.
const ARIA_ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote',
  'button', 'caption', 'cell', 'checkbox', 'code', 'columnheader',
  'combobox', 'complementary', 'contentinfo', 'definition', 'deletion',
  'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure', 'form',
  'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion',
  'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math',
  'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'meter', 'navigation', 'none', 'note', 'option', 'paragraph',
  'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row',
  'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator',
  'slider', 'spinbutton', 'status', 'strong', 'subscript', 'superscript',
  'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox',
  'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
]);

// A string literal in the grammar: single-quoted, single-line, no escape
// processing in v1 (a value containing ' is not expressible — fog).
const STR = `'[^'\\n]*'`;
const NUM = `[0-9]+`;

const SIMPLE_GETTERS = '(?:getByLabel|getByPlaceholder|getByAltText|getByTitle|getByText|getByTestId)';
// Prefix form for consume (a chain may follow); the whole-string check is
// enforced by consuming until the string is empty.
const SIMPLE_GETTER_PREFIX_RE = new RegExp(String.raw`^${SIMPLE_GETTERS}\(${STR}\)`);

// ------------------------------------------------------------ plan parsing

// Thrown on a structurally unreadable plan. The message carries the line
// number — "fail loud" means the human can point at the offending line.
export class PlanParseError extends Error {}

// Parse the keyed-line plan format into {header, steps}. Throws
// PlanParseError on any structural violation — a plan that does not parse
// never reaches validation, let alone a model.
//
//   profile: test        <- header: key: value lines, closed schema
//   title: user can sign in
//   file: user-can-sign-in
//   next_id: s7
//   ---
//   ## steps
//
//   - id: s1
//     action: go to the login page
//     locator: none
//   - id: s2
//     action: fill the email field
//     locator: getByLabel('Email')
//     value: env:E2E_USER
//     reason: label present on the form
export function parsePlan(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new PlanParseError('plan is empty');
  }
  if (text.includes('\r')) {
    throw new PlanParseError(
      'plan contains CR characters — plans are LF-only (`*.plan.md text eol=lf` in .gitattributes); fix the line endings',
    );
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (/[^\x00-\x7F]/.test(line)) {
      throw new PlanParseError(
        `line ${i + 1}: non-ASCII character — plans are ASCII-only (the spec title token rule extends to the plan)`,
      );
    }
    if (/[ \t]+$/.test(line)) {
      throw new PlanParseError(
        `line ${i + 1}: trailing whitespace — it changes the sha256 stamp for no semantic reason and breaks regen action matching`,
      );
    }
  });

  let i = 0;
  const isBlank = (line) => /^\s*$/.test(line);
  const skipBlank = () => { while (i < lines.length && isBlank(lines[i])) i++; };

  // Header: closed schema, exactly-once keys.
  const header = {};
  const HEADER_KEYS = new Set(['profile', 'title', 'file', 'next_id']);
  skipBlank();
  while (i < lines.length && lines[i] !== '---') {
    const m = lines[i].match(/^(\w+): (.*)$/);
    if (!m) {
      throw new PlanParseError(
        `line ${i + 1}: expected a header line \`key: value\` or the \`---\` separator, got: ${lines[i]}`,
      );
    }
    const [, key, value] = m;
    if (!HEADER_KEYS.has(key)) {
      throw new PlanParseError(
        `line ${i + 1}: unknown header key \`${key}\` (the header is a closed schema: profile, title, file, next_id)`,
      );
    }
    if (key in header) {
      throw new PlanParseError(`line ${i + 1}: duplicate header key \`${key}\``);
    }
    header[key] = value;
    i++;
  }
  if (i >= lines.length) {
    throw new PlanParseError('missing the `---` separator between header and steps');
  }
  i++; // consume ---
  skipBlank();
  if (i >= lines.length || lines[i] !== '## steps') {
    throw new PlanParseError(
      `line ${i + 1}: expected \`## steps\` after the header separator`,
    );
  }
  i++;

  // Steps: `- id: sN` opens a step; indented `key: value` lines extend it.
  const STEP_KEYS = new Set(['action', 'locator', 'value', 'expect', 'reason']);
  const steps = [];
  let current = null;
  for (; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    const open = lines[i].match(/^- id: (.*)$/);
    if (open) {
      current = { id: open[1], line: i + 1 };
      steps.push(current);
      continue;
    }
    const field = lines[i].match(/^\s+(\w+): (.*)$/);
    if (!field) {
      throw new PlanParseError(
        `line ${i + 1}: expected \`- id: sN\` or an indented \`key: value\` step field, got: ${lines[i]}`,
      );
    }
    if (!current) {
      throw new PlanParseError(
        `line ${i + 1}: step field before any \`- id: sN\` line`,
      );
    }
    const [, key, value] = field;
    if (key === 'id') {
      throw new PlanParseError(
        `line ${i + 1}: \`id\` belongs on the \`- id: sN\` opening line only`,
      );
    }
    if (!STEP_KEYS.has(key)) {
      throw new PlanParseError(
        `line ${i + 1}: unknown step key \`${key}\` (allowed: action, locator, value, expect, reason)`,
      );
    }
    if (key in current) {
      throw new PlanParseError(`line ${i + 1}: duplicate step key \`${key}\``);
    }
    current[key] = value;
  }
  return { header, steps };
}

// ------------------------------------------------------- slot grammar (Q12)

// Validate one locator slot expression. Returns {ok:true, usesPosition} or
// {ok:false, problem}. `usesPosition` flags .first()/.last()/.nth() so the
// caller can enforce the non-empty-reason rule.
//
// Grammar: one expression, whitelisted calls only, every argument a string
// literal, a number literal, or { name: '<str>' } / { exact: true } /
// { hasText: '<str>' }. Banned without exception: page.locator, page.$/$$,
// engine prefixes (css=, xpath=, id=, text=), frameLocator, regex-valued
// args, and any non-literal argument (no variables, template literals, or
// concatenation — that rule is what makes this a regex, not a parser).
export function lintLocator(slot) {
  if (typeof slot !== 'string' || slot.length === 0) {
    return { ok: false, problem: 'empty locator slot' };
  }
  // Banned constructs first, for messages that name the actual rule broken
  // (a bare "no grammar match" sends the human hunting).
  const banned = [
    [/\bpage\.locator\s*\(/, 'page.locator() is banned — use a whitelisted getBy* root'],
    [/\bpage\.\$\$?\s*\(/, 'page.$()/$$() are banned — use a whitelisted getBy* root'],
    [/\bframeLocator\b/, 'frameLocator is banned in v1 (iframes are fog)'],
    [/`/, 'template literals are banned — every locator argument is a literal'],
    [/\$\{/, 'interpolation is banned — every locator argument is a literal'],
    [/\(\s*'(css|xpath|id|text)=/, "engine prefixes (css=/xpath=/id=/text=) are banned"],
    [/\(\s*\//, 'regex-valued locator arguments are banned in v1 (fog)'],
  ];
  for (const [re, message] of banned) {
    if (re.test(slot)) return { ok: false, problem: message };
  }
  if (slot.includes('(') && !/^[A-Za-z]/.test(slot)) {
    return { ok: false, problem: 'locator must start with a whitelisted getBy* call' };
  }

  // Consume: root call, then chained segments, requiring whole-string match.
  let rest = slot;
  let usesPosition = false;
  const consumeRoot = () => {
    const role = rest.match(new RegExp(String.raw`^getByRole\('([a-z]+)'(, \{ name: ${STR}(, exact: true)? \})?\)`));
    if (role) {
      if (!ARIA_ROLES.has(role[1])) {
        return { done: false, problem: `unknown ARIA role '${role[1]}' in getByRole` };
      }
      rest = rest.slice(role[0].length);
      return { done: true };
    }
    const simple = rest.match(SIMPLE_GETTER_PREFIX_RE);
    if (simple) {
      rest = rest.slice(simple[0].length);
      return { done: true };
    }
    return { done: false, problem: `not a whitelisted locator call: ${rest}` };
  };
  const r0 = consumeRoot();
  if (!r0.done) return { ok: false, problem: r0.problem };
  while (rest.length > 0) {
    if (rest.startsWith('.')) {
      let seg = rest.slice(1);
      const filter = seg.match(new RegExp(String.raw`^filter\(\{ hasText: ${STR} \}\)`));
      if (filter) { rest = seg.slice(filter[0].length); continue; }
      const pos = seg.match(/^(first|last)\(\)/);
      if (pos) { usesPosition = true; rest = seg.slice(pos[0].length); continue; }
      const nth = seg.match(new RegExp(String.raw`^nth\(${NUM}\)`));
      if (nth) { usesPosition = true; rest = seg.slice(nth[0].length); continue; }
      const scoped = seg.match(/^getBy/);
      if (scoped) {
        rest = seg; // reuse the root consumer as a segment consumer
        const r = consumeRoot();
        if (!r.done) return { ok: false, problem: r.problem };
        continue;
      }
    }
    return { ok: false, problem: `cannot parse locator chain at: ${rest}` };
  }
  return { ok: true, usesPosition };
}

// ---------------------------------------------------- value/expect grammar

const VALUE_LITERAL_RE = /^literal '([^'\n]*)'$/;
const VALUE_ENV_RE = /^env:(E2E_[A-Z0-9_]+)$/;

const EXPECT_FORMS = {
  bare: new Set(['visible', 'hidden', 'enabled', 'disabled', 'checked', 'unchecked']),
  str: new Set(['text', 'contains', 'value', 'url', 'title']),
};

// Validate an expect: field. Returns {ok:true, pageLevel} or
// {ok:false, problem}.
export function lintExpect(field) {
  if (EXPECT_FORMS.bare.has(field)) return { ok: true, pageLevel: false };
  const str = field.match(/^(\w+) '([^'\n]*)'$/);
  if (str && EXPECT_FORMS.str.has(str[1])) {
    return { ok: true, pageLevel: str[1] === 'url' || str[1] === 'title' };
  }
  const count = field.match(new RegExp(String.raw`^count ${NUM}$`));
  if (count) return { ok: true, pageLevel: false };
  return {
    ok: false,
    problem: `expect must be one of: visible, hidden, enabled, disabled, checked, unchecked, text '<str>', contains '<str>', value '<str>', count <n>, url '<str>', title '<str>' (flat enum, literal args — got: ${field})`,
  };
}

// ---------------------------------------------------------- plan validation

// Plan-level boundary validation: everything checkable before any model
// call. Returns {ok:true, envNames} or {ok:false, problems[]}. Problems are
// human-pointable strings ("line N: ..."), one per violation — the human
// fixes the plan; the harness never repairs it.
export function validatePlan(plan) {
  const problems = [];
  const { header, steps } = plan;
  const at = (line, msg) => problems.push(`line ${line}: ${msg}`);
  const stepLine = (step) => step.line ?? '?';

  // Header.
  if (header.profile !== 'test') {
    problems.push(`header: profile must be \`test\` (browsing plans are unresolved scope, not a silent value)`);
  }
  if (!header.title) problems.push('header: missing `title`');
  if (!header.file || !FILE_SLUG_RE.test(header.file)) {
    problems.push(`header: \`file\` must be a lowercase slug (got: ${header.file ?? '<missing>'})`);
  }
  const next = header.next_id?.match(ID_RE);
  if (!next) {
    problems.push(`header: \`next_id\` must be s<N> (got: ${header.next_id ?? '<missing>'})`);
  }
  const nextNum = next ? Number(next[1]) : null;

  if (steps.length === 0) problems.push('plan has no steps');

  // Ids: format, uniqueness, below the high-water mark.
  const seenIds = new Map();
  for (const step of steps) {
    const m = step.id.match(ID_RE);
    if (!m) {
      at(stepLine(step), `id \`${step.id}\` is not of the form s<N>`);
      continue;
    }
    if (seenIds.has(step.id)) {
      at(stepLine(step), `duplicate id ${step.id} (first used on line ${seenIds.get(step.id)}) — a copy-paste hand-edit makes two of one step; ids are never reused`);
    } else {
      seenIds.set(step.id, stepLine(step));
    }
    if (nextNum !== null && Number(m[1]) >= nextNum) {
      at(stepLine(step), `id ${step.id} is at or above next_id ${header.next_id} — the high-water mark is the first id never issued`);
    }
  }

  // Action text: required; duplicates are rejected at generate so regen
  // matching is never ambiguous.
  const seenActions = new Map();
  for (const step of steps) {
    if (!step.action) {
      at(stepLine(step), `step ${step.id} is missing \`action:\``);
      continue;
    }
    if (seenActions.has(step.action)) {
      at(stepLine(step), `duplicate action "${step.action}" (first on line ${seenActions.get(step.action)}) — action text is the regen match key; make the two actions textually distinct`);
    } else {
      seenActions.set(step.action, stepLine(step));
    }
  }

  // Per-step fields.
  for (const step of steps) {
    const where = `step ${step.id} (line ${stepLine(step)})`;
    if (!step.locator) {
      problems.push(`${where} is missing \`locator:\` (write \`locator: none\` for a slotless step)`);
      continue;
    }
    const slotless = step.locator === 'none';

    if (!slotless) {
      const loc = lintLocator(step.locator);
      if (!loc.ok) {
        problems.push(`${where} locator rejected: ${loc.problem}`);
      } else if (loc.usesPosition && !step.reason) {
        problems.push(`${where} uses .first()/.last()/.nth() — \`reason:\` must be non-empty and name the position`);
      }
    }

    if (step.value !== undefined && step.expect !== undefined) {
      problems.push(`${where} has both \`value:\` and \`expect:\` — an input step and an assertion step are different steps`);
    }

    if (step.value !== undefined) {
      const lit = step.value.match(VALUE_LITERAL_RE);
      const env = step.value.match(VALUE_ENV_RE);
      if (!lit && !env) {
        problems.push(`${where} value must be \`literal '<str>'\` or \`env:E2E_NAME\` (got: ${step.value})`);
      } else if (env && !ENV_NAME_RE.test(env[1])) {
        problems.push(`${where} env name ${env[1]} must match ^E2E_[A-Z0-9_]+$`);
      }
    }

    if (step.expect !== undefined) {
      const exp = lintExpect(step.expect);
      if (!exp.ok) {
        problems.push(`${where} ${exp.problem}`);
      } else {
        if (exp.pageLevel && !slotless) {
          problems.push(`${where} page-level assertion (${step.expect.split(' ')[0]}) must have \`locator: none\``);
        }
        if (!exp.pageLevel && slotless) {
          problems.push(`${where} locator-bearing assertion (${step.expect.split(' ')[0]}) has \`locator: none\` — there is nothing to assert on`);
        }
        // hidden passes when the element is absent — the only form that can
        // pass for the wrong reason; the reason field forces one human look
        // at the gate.
        if (step.expect === 'hidden' && !step.reason) {
          problems.push(`${where} \`expect: hidden\` requires a non-empty \`reason:\` (toBeHidden passes on an absent element — say why this absence-proof is real)`);
        }
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    envNames: [...new Set(steps.map((s) => s.value?.match(VALUE_ENV_RE)?.[1]).filter(Boolean))],
  };
}

// parse + validate in one call.
export function checkPlan(text) {
  let plan;
  try {
    plan = parsePlan(text);
  } catch (err) {
    if (err instanceof PlanParseError) return { ok: false, problems: [err.message] };
    throw err;
  }
  const v = validatePlan(plan);
  return v.ok ? { ok: true, plan, envNames: v.envNames } : v;
}

// ------------------------------------------------------------- spec lint

export const STEP_TITLE_RE = STEP_TOKEN_RE;

// Lint a generated .spec.ts source. The companion to validatePlan: the plan
// is linted on intake, the spec is linted on output — the generator emits
// code, so the things the plan grammar cannot express (soft assertions,
// per-step timeouts, multi-line slots) are caught here.
export function lintSpec(source) {
  const problems = [];
  const at = (msg) => problems.push(msg);
  const lines = source.split('\n');

  // Denials that are one regex each.
  if (/\bexpect\.soft\s*\(/.test(source)) {
    at('expect.soft() is banned — a soft failure lets a test finish `passed` with a failed assertion and corrupts the outcome contract at the root');
  }
  if (/\btimeout\s*:/.test(source)) {
    at('explicit timeouts are banned in generated specs ({ timeout: ... }) — Playwright defaults apply; a slow step is a signal, not a wait to tune');
  }
  if (/\bstorageState\b/.test(source)) {
    at('storageState is forbidden — login is ordinary plan steps with env: credentials; a saved auth artifact fails a clean runner and skips the heal loop');
  }
  if (/\bpage\.locator\s*\(|\bpage\.\$\$?\s*\(|\bframeLocator\b/.test(source)) {
    at('page.locator()/page.$()/frameLocator are banned — locator slots use the whitelisted getBy* grammar');
  }
  const goto = source.match(/page\.goto\(\s*('([^'\n]*)'|[^)]*)\)/);
  if (goto) {
    const arg = goto[2];
    if (arg === undefined) {
      at('page.goto() argument must be a string literal');
    } else if (!arg.startsWith('/')) {
      at(`page.goto('${arg}') is not a relative URL — URLs start with / (no scheme/host/port; baseURL comes from the consumer config)`);
    }
  }

  // Env closure: every process.env.E2E_X referenced under the module-top
  // throw-guard pattern, never with a ?? fallback literal.
  const envUses = [...source.matchAll(/process\.env\.(E2E_[A-Z0-9_]+)/g)].map((m) => m[1]);
  for (const name of new Set(envUses)) {
    const decl = new RegExp(`const ${name} = process\\.env\\.${name};`);
    const guard = new RegExp(`if \\(!${name}\\) throw`);
    if (!decl.test(source) || !guard.test(source)) {
      at(`env var ${name} is used without the module-top throw-guard (const ${name} = process.env.${name}; if (!${name}) throw ...) — a missing secret must be a file-level config failure, not an empty fill`);
    }
  }
  if (/process\.env\.\w+\s*\?\?/.test(source)) {
    at('process.env.X ?? ... is banned — a fallback literal smuggles a credential into the spec (C2) and turns a missing secret into a confusing assertion failure');
  }

  // Step titles: every test.step carries a bracketed id token; line-level
  // scan also enforces the one-line-slot emission rule on locator lines.
  const ids = [];
  lines.forEach((line, i) => {
    const call = line.match(/test\.step\(\s*'([^'\n]*)'/);
    if (call) {
      const m = call[1].match(STEP_TOKEN_RE);
      if (!m) {
        at(`line ${i + 1}: test.step title "${call[1]}" does not start with an id token — expected \`[sN] <action>\``);
      } else {
        ids.push({ id: m[1], line: i + 1 });
      }
    }
    if (/\bgetBy(Role|Label|Placeholder|AltText|Title|Text|TestId)\(/.test(line)) {
      const opens = (line.match(/\(/g) ?? []).length;
      const closes = (line.match(/\)/g) ?? []).length;
      if (opens !== closes) {
        at(`line ${i + 1}: locator slot spans multiple lines — a slot is one expression on one line (the heal patcher is regex surgery, not a parser)`);
      }
    }
  });
  const seen = new Map();
  for (const { id, line } of ids) {
    if (seen.has(id)) {
      at(`line ${line}: duplicate step token [${id}] (first used on line ${seen.get(id)}) — the patcher's token scan would be ambiguous; refusing`);
    } else {
      seen.set(id, line);
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, ids: ids.map((x) => x.id) };
}
