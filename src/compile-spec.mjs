// Spec compiler (FYR-330): approved plan bytes in, stamped pair out.
//
// The plan is consumed VERBATIM (the sha256 stamp must match the exact bytes
// the human approved) and compiled into one `.spec.ts`: every step is one
// `test.step('[sN] <action>')`, one locator slot, literal-only grammar,
// `env:E2E_*` module-top throw-guards. The `.plan.md` is kept byte-identical.
// The compiled spec must pass `lintSpec` before it is written.
//
// Placement (FYR-251): both artifacts land in the consumer repo's testDir
// (`<testDir>/<file>.spec.ts` + `<testDir>/<file>.plan.md`). The consumer's
// Playwright config owns testDir; this compiler never chooses a path.
//
// Regen (FYR-251 Q6/Q7): overwrite iff `git status --porcelain` is clean.
// Regeneration matches surviving steps on action text via `matchIds` —
// heal-patched locators are a RESET on regen unless promoted through a plan
// edit + re-approval.
import { createHash } from "node:crypto";
import { parsePlan, lintSpec } from "./plan-parse.mjs";
import { matchIds } from "./id-match.mjs";

export class GenerateError extends Error {
  constructor(message, { exitCode = 1, problems } = {}) {
    super(message);
    this.name = "GenerateError";
    this.exitCode = exitCode;
    this.problems = problems;
  }
}

export function planSha256(planBytes) {
  return createHash("sha256").update(planBytes).digest("hex");
}

/** Literal-only value forms: `literal '<text>'` and `env:E2E_*`. */
function compileValue(raw, { at }) {
  if (raw === undefined || raw === null || raw === "") {
    throw new GenerateError(`${at}: step has no \`value:\` — write \`literal '...'\` or \`env:E2E_X\``);
  }
  if (raw.startsWith("env:")) {
    const name = raw.slice(4);
    if (!/^E2E_[A-Z0-9_]+$/.test(name)) {
      throw new GenerateError(`${at}: env value "${raw}" is not env:E2E_<UPPER> — credentials ride E2E_* env vars only`);
    }
    return { kind: "env", name, expr: name };
  }
  const m = raw.match(/^literal '(.*)'$/s);
  if (!m) {
    throw new GenerateError(`${at}: value "${raw}" is neither \`literal '...'\` nor \`env:E2E_X\` — two forms, both literal, no interpolation`);
  }
  return { kind: "literal", text: m[1], expr: m[1] };
}

/**
 * Compile a validated plan into spec source. Pure: bytes in, string out.
 * @param {object} plan - parsed plan ({header, steps}) with ids already assigned
 * @returns {string} spec source (unstamped; caller prepends the stamp line)
 */
export function compileSpec(plan) {
  const { header, steps } = plan;
  const out = [];
  const envNames = new Set();

  for (const step of steps) {
    // step titles are single-quoted (lintSpec scans single-quoted test.step titles)
  const singleQuote = (text) => `'${text.replace(/'/g, "\\'")}'`;
  const action = singleQuote(`[${step.id}] ${step.action}`);
    const body = [];

    const value = step.value !== undefined ? compileValue(step.value, { at: `step ${step.id}` }) : null;
    if (value?.kind === "env") envNames.add(value.name);

    if (step.locator === "none") {
      // Slotless: the only legal actions are goto (value) or a bare assertion.
      if (step.action.startsWith("go to ")) {
        if (!value || value.kind !== "literal" || !value.text.startsWith("/")) {
          throw new GenerateError(`step ${step.id}: a "go to" step needs \`value: literal '/relative/path'\` — URLs are relative; baseURL comes from the consumer config`);
        }
        out.push(`  await test.step(${action}, async () => {`);
        out.push(`    await page.goto('${value.text}');`);
        out.push(`  });`);
        continue;
      }
      if (step.expect) {
        throw new GenerateError(`step ${step.id}: locator: none with an expect is not representable — a bare assertion needs a locator to assert on`);
      }
      throw new GenerateError(`step ${step.id}: locator: none but the action is not a "go to" step — slotless steps are navigation only in v1`);
    }

    // Slotted step: exactly one locator expression on one line.
    const target = step.locator;
    if (step.expect) {
      const expected = { visible: "toBeVisible()", hidden: "toBeHidden()" }[step.expect];
      if (!expected) {
        throw new GenerateError(`step ${step.id}: expect "${step.expect}" is not in {visible, hidden}`);
      }
      if (step.expect === "hidden" && !step.reason) {
        throw new GenerateError(`step ${step.id}: \`hidden\` expect requires a non-empty \`reason:\` (asserting absence is the strong claim)`);
      }
      out.push(`  await test.step(${action}, async () => {`);
      out.push(`    await expect(page.${step.locator}).${expected};`);
      out.push(`  });`);
      continue;
    }

    if (!value) {
      // Click-style step: locator, no value.
      out.push(`  await test.step(${action}, async () => {`);
      out.push(`    await page.${step.locator}.click();`);
      out.push(`  });`);
      continue;
    }

    // value + locator → fill-style.
    const rhs = value.kind === "env" ? value.name : JSON.stringify(value.text);
    out.push(`  await test.step(${action}, async () => {`);
    out.push(`    await page.${step.locator}.fill(${rhs});`);
    out.push(`  });`);
  }

  const lines = [];
  if (envNames.size > 0) {
    lines.push("import { test, expect } from '@playwright/test';");
    lines.push("");
    for (const name of [...envNames].sort()) {
      lines.push(`const ${name} = process.env.${name};`);
      lines.push(`if (!${name}) throw new Error('missing env var ${name}');`);
    }
    lines.push("");
  } else {
    lines.push("import { test, expect } from '@playwright/test';");
    lines.push("");
  }
  lines.push(`test(${JSON.stringify(header.title)}, async ({ page }) => {`);
  lines.push(...out);
  lines.push("});");
  return lines.join("\n") + "\n";
}

/**
 * Assign ids to a new plan by matching action text against the previous plan
 * (regen). Returns { plan, assignments, deadIds } — ids in `plan.steps` are
 * rewritten from the assignments; healed locators reset by construction (the
 * new plan's locator wins).
 */
export function assignRegenIds({ newPlanBytes, oldPlan }) {
  const newPlan = parsePlan(newPlanBytes);
  const res = matchIds({ oldSteps: oldPlan.steps, newSteps: newPlan.steps, nextId: oldPlan.header.next_id });
  if (!res.ok) {
    throw new GenerateError(`regen matching failed:\n${res.problems.map((p) => `  - ${p}`).join("\n")}`, { problems: res.problems });
  }
  for (const a of res.assignments) {
    newPlan.steps[a.index].id = a.id;
  }
  newPlan.header.next_id = res.nextId;
  // Renumber any fresh ids the matcher minted so they follow action order.
  return { plan: newPlan, assignments: res.assignments, deadIds: res.deadIds };
}