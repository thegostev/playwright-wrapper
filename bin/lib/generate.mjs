// `generate` subcommand (FYR-330): approved plan bytes on stdin → validated,
// compiled, stamped pair written into the consumer repo — git-tracked.
//
// Refusal rules (FYR-251 Q6, loud + before any write):
//   - stdin empty or plan invalid → exit 1, no write
//   - outside a git repo → exit 1
//   - dirty/untracked tree (git status --porcelain non-empty) → exit 1
//   - existing stamped pair: regen path — match ids on action text, refuse if
//     the tree is dirty (same rule)
// The spec is stamped with the sha256 of the exact consumed bytes and must
// pass lintSpec before anything is written.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parsePlan, validatePlan, lintSpec } from "../../src/plan-parse.mjs";
import { compileSpec, assignRegenIds, planSha256, GenerateError } from "../../src/compile-spec.mjs";

const USAGE = `playwright-wrapper generate — compile an approved plan into a stamped spec pair

Usage:
  playwright-wrapper generate < approved-plan.md

Reads the approved plan verbatim from stdin, validates it against the
generator-output contract, then writes into the consumer repo's testDir:
  <testDir>/<file>.spec.ts   first line // plan-sha256: <sha256 of plan bytes>
  <testDir>/<file>.plan.md   the plan bytes, kept byte-identical
Refuses on a dirty/untracked/outside-repo tree (overwrite needs a clean tree);
regen matches surviving steps on action text and resets healed locators.
The consumer's playwright.config.ts owns testDir (default: ./tests).`;

function gitOut(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function runGenerate({ stdin, cwd = process.cwd(), env = process.env }) {
  // 1. Consume the plan verbatim.
  const planBytes = stdin;
  if (!planBytes || planBytes.trim() === "") {
    throw new GenerateError("no plan on stdin — pipe the approved plan: playwright-wrapper generate < plan.md", { exitCode: 2 });
  }

  // 2. Validate against the generator-output contract (before any git work).
  let plan;
  try {
    plan = parsePlan(planBytes);
  } catch (err) {
    throw new GenerateError(`plan rejected: ${err.message}`);
  }
  const validation = validatePlan(plan);
  if (!validation.ok) {
    throw new GenerateError(`plan failed the generator-output contract:\n${validation.problems.map((p) => `  - ${p}`).join("\n")}`, { problems: validation.problems });
  }

  // 3. Repo + cleanliness gate — loud, before any write.
  let repoRoot;
  try {
    repoRoot = gitOut(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    throw new GenerateError("not inside a git repository — the stamped pair is git-tracked by contract; run from the consumer repo");
  }
  const status = gitOut(["status", "--porcelain"], repoRoot);
  if (status !== "") {
    throw new GenerateError(
      `working tree is dirty/untracked (${status.split("\n").length} entries) — overwrite writes only onto a clean tree (FYR-251 Q6: git makes overwrite cheap; dirty-state writes are how generated artifacts get mixed with uncommitted work). Commit or stash first.`,
    );
  }

  // 4. Placement from the consumer config contract.
  const testDir = findConsumerTestDir(repoRoot);
  const specPath = path.join(repoRoot, testDir, `${plan.header.file}.spec.ts`);
  const planPath = path.join(repoRoot, testDir, `${plan.header.file}.plan.md`);

  // 5. Regen: match surviving steps on action text.
  let assignments = null;
  let deadIds = [];
  if (existsSync(planPath)) {
    const oldBytes = readFileSync(planPath, "utf8");
    const oldPlan = parsePlan(oldBytes);
    const regen = assignRegenIds({ newPlanBytes: planBytes, oldPlan });
    plan = regen.plan;
    assignments = regen.assignments;
    deadIds = regen.deadIds;
  }

  // 6. Compile + lint the spec BEFORE writing.
  const specBody = compileSpec(plan);
  const stamp = `// plan-sha256: ${planSha256(planBytes)}`;
  const specSource = `${stamp}\n${specBody}`;
  const lint = lintSpec(specSource);
  if (!lint.ok) {
    throw new GenerateError(`compiled spec failed the spec lint:\n${lint.problems.map((p) => `  - ${p}`).join("\n")}`, { problems: lint.problems });
  }

  // 7. Write the stamped pair.
  mkdirSync(path.dirname(specPath), { recursive: true });
  writeFileSync(specPath, specSource);
  writeFileSync(planPath, planBytes.endsWith("\n") ? planBytes : planBytes + "\n");

  return { specPath, planPath, sha: planSha256(planBytes), specIds: lint.ids, assignments, deadIds, testDir };
}

function findConsumerTestDir(repoRoot) {
  const cfg = path.join(repoRoot, "playwright.config.ts");
  if (existsSync(cfg)) {
    const src = readFileSync(cfg, "utf8");
    const m = src.match(/testDir\s*:\s*['"]([^'"]+)['"]/);
    if (m) return m[1];
  }
  return "tests";
}

export async function generateMain(argv) {
  let planBytes = "";
  for await (const chunk of process.stdin) planBytes += chunk;
  try {
    const res = runGenerate({ stdin: planBytes });
    process.stdout.write(
      `generate: wrote the stamped pair (plan-sha256: ${res.sha})\n` +
        `  ${res.specPath}\n  ${res.planPath}\n` +
        `  ids: ${res.specIds.join(", ")}\n` +
        (res.assignments ? `  regen: kept ${res.assignments.filter((a) => a.source === "kept").length}, fresh ${res.assignments.filter((a) => a.source !== "kept").length}${res.deadIds.length ? `, dead ids: ${res.deadIds.join(", ")}` : ""}\n` : "") +
        `  both files are untracked — review and \`git add\` them (the tree was clean at write time).\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof GenerateError) {
      process.stderr.write(`playwright-wrapper generate: ${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }
}