// LAG-574: the `skill install` subcommand, spawned end to end with HOME
// pointed at a scratch directory — the real filesystem path, not a stub.
//
// The behaviour under test is the drift contract: the installed copy carries a
// version stamp, an unedited copy upgrades in place across a version bump, and
// an edited copy is never overwritten without --force.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitStamp, applyStamp, runSkillInstall, SkillError } from "../bin/lib/skill.mjs";

const BIN = fileURLToPath(new URL("../bin/playwright-wrapper.mjs", import.meta.url));
const ROOT = path.dirname(path.dirname(BIN));
const SOURCE = readFileSync(path.join(ROOT, "skill", "SKILL.md"), "utf8");
const VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const REL = path.join(".claude", "skills", "playwright-wrapper", "SKILL.md");

function scratchHome(t) {
  const home = mkdtempSync(path.join(tmpdir(), "pw-skill-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

// The bin is spawned WITHOUT an Ollama key on purpose: installing the skill on
// a fresh machine must not require the LLM config to be set yet.
function spawnBin(args, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  delete env.WRAPPER_OLLAMA_API_KEY;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("install: writes the stamped skill into ~/.claude/skills, creating the directory", async (t) => {
  const home = scratchHome(t);
  const { code, stdout, stderr } = await spawnBin(["skill", "install"], { HOME: home });
  assert.equal(code, 0, stderr);
  const target = path.join(home, REL);
  assert.ok(existsSync(target), "the skill landed at ~/.claude/skills/playwright-wrapper/SKILL.md");
  assert.match(stdout, /installed/);
  assert.ok(stdout.includes(target), "the message names the path it wrote");

  const written = readFileSync(target, "utf8");
  const { body, version } = splitStamp(written);
  assert.equal(version, VERSION, "the installed copy is stamped with the package version");
  assert.equal(body, splitStamp(SOURCE).body, "the body is the packaged skill, byte for byte");
  assert.match(written, /^---\nname: playwright-wrapper\n/, "frontmatter survives the stamp");
});

test("install needs no LLM key: the config gate never runs for it", async (t) => {
  const home = scratchHome(t);
  // A malformed base URL is a loud exit-1 config error for every model-driven
  // subcommand. skill install dispatches before that gate, so it still passes.
  const { code, stderr } = await spawnBin(["skill", "install"], {
    HOME: home,
    WRAPPER_OLLAMA_BASE_URL: "not a url at all",
  });
  assert.equal(code, 0, stderr);
  assert.ok(existsSync(path.join(home, REL)));
});

test("second install of the same version is a no-op that says so", async (t) => {
  const home = scratchHome(t);
  await spawnBin(["skill", "install"], { HOME: home });
  const before = readFileSync(path.join(home, REL), "utf8");
  const { code, stdout } = await spawnBin(["skill", "install"], { HOME: home });
  assert.equal(code, 0);
  assert.match(stdout, /already current/);
  assert.match(stdout, new RegExp(`v${VERSION.replace(/\./g, "\\.")}`));
  assert.equal(readFileSync(path.join(home, REL), "utf8"), before, "nothing was rewritten");
});

test("upgrade: an unedited copy from an older version is replaced, naming both versions", async (t) => {
  const home = scratchHome(t);
  const target = path.join(home, REL);
  mkdirSync(path.dirname(target), { recursive: true });
  // Same body, older stamp — exactly what a package upgrade leaves behind.
  writeFileSync(target, applyStamp(SOURCE, "0.9.0"), "utf8");

  const { code, stdout } = await spawnBin(["skill", "install"], { HOME: home });
  assert.equal(code, 0);
  assert.match(stdout, /upgraded/);
  assert.match(stdout, /0\.9\.0/, "the refusal-free upgrade still names the version it replaced");
  assert.equal(splitStamp(readFileSync(target, "utf8")).version, VERSION, "the stamp matches the bin");
});

test("refuse-on-diff: a locally edited copy is never silently overwritten", async (t) => {
  const home = scratchHome(t);
  const target = path.join(home, REL);
  mkdirSync(path.dirname(target), { recursive: true });
  const edited = applyStamp(SOURCE + "\nA line a human added.\n", "0.9.0");
  writeFileSync(target, edited, "utf8");

  const { code, stdout, stderr } = await spawnBin(["skill", "install"], { HOME: home });
  assert.equal(code, 1, "a refusal is an error exit, not a quiet success");
  assert.equal(stdout, "", "nothing on stdout when it refuses");
  assert.match(stderr, /0\.9\.0/, "the refusal names the installed version");
  assert.match(stderr, new RegExp(`v${VERSION.replace(/\./g, "\\.")}`), "and the package version");
  assert.match(stderr, /--force/, "and how to override it");
  assert.equal(readFileSync(target, "utf8"), edited, "the edited copy is left untouched");
});

test("refuse-on-diff: an unstamped copy is treated as edited, not as an upgrade", async (t) => {
  const home = scratchHome(t);
  const target = path.join(home, REL);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "---\nname: playwright-wrapper\n---\n\nHand-written.\n", "utf8");

  const { code, stderr } = await spawnBin(["skill", "install"], { HOME: home });
  assert.equal(code, 1);
  assert.match(stderr, /unstamped/);
});

test("force: --force replaces an edited copy and re-stamps it", async (t) => {
  const home = scratchHome(t);
  const target = path.join(home, REL);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, applyStamp(SOURCE + "\nA line a human added.\n", "0.9.0"), "utf8");

  const { code, stdout } = await spawnBin(["skill", "install", "--force"], { HOME: home });
  assert.equal(code, 0);
  assert.match(stdout, /replaced/);
  const written = readFileSync(target, "utf8");
  assert.equal(splitStamp(written).body, splitStamp(SOURCE).body, "the edit is gone");
  assert.equal(splitStamp(written).version, VERSION);
});

test("print: --print writes the stamped skill to stdout and touches nothing", async (t) => {
  const home = scratchHome(t);
  const { code, stdout } = await spawnBin(["skill", "install", "--print"], { HOME: home });
  assert.equal(code, 0);
  assert.equal(splitStamp(stdout).version, VERSION, "stdout carries the same stamp as a real install");
  assert.equal(splitStamp(stdout).body, splitStamp(SOURCE).body);
  assert.ok(!existsSync(path.join(home, ".claude")), "--print creates no directory");
});

test("print does not refuse: it works over an edited copy too", async (t) => {
  const home = scratchHome(t);
  const target = path.join(home, REL);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, applyStamp(SOURCE + "\nedited\n", "0.9.0"), "utf8");
  const { code, stdout } = await spawnBin(["skill", "install", "--print"], { HOME: home });
  assert.equal(code, 0);
  assert.equal(splitStamp(stdout).body, splitStamp(SOURCE).body);
  assert.match(readFileSync(target, "utf8"), /edited/, "the installed copy is still untouched");
});

test("usage errors exit 2: bare `skill`, an unknown action, an unknown flag", async (t) => {
  const home = scratchHome(t);
  const bare = await spawnBin(["skill"], { HOME: home });
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /missing action/);

  const wrong = await spawnBin(["skill", "uninstall"], { HOME: home });
  assert.equal(wrong.code, 2);
  assert.match(wrong.stderr, /unknown action "uninstall"/);

  const flag = await spawnBin(["skill", "install", "--dry-run"], { HOME: home });
  assert.equal(flag.code, 2);
  assert.match(flag.stderr, /unknown option "--dry-run"/);

  assert.ok(!existsSync(path.join(home, ".claude")), "no usage error writes anything");
});

test("--help lists five subcommands, and `skill --help` documents the subcommand", async () => {
  const help = await spawnBin(["--help"]);
  assert.equal(help.code, 0);
  for (const sub of ["plan", "generate", "heal", "browse", "skill"]) {
    assert.ok(help.stdout.includes(sub), `usage lists ${sub}`);
  }
  const skillHelp = await spawnBin(["skill", "--help"]);
  assert.equal(skillHelp.code, 0);
  assert.match(skillHelp.stdout, /playwright-wrapper skill install/);
});

test("the packaged skill is a well-formed, model-invoked skill with a name+description frontmatter", () => {
  const lines = SOURCE.split("\n");
  assert.equal(lines[0], "---", "frontmatter opens on line 1");
  const close = lines.indexOf("---", 1);
  assert.ok(close > 0, "frontmatter closes");
  const keys = lines
    .slice(1, close)
    .filter((l) => /^\S/.test(l))
    .map((l) => l.split(":")[0]);
  assert.deepEqual(keys, ["name", "description"], "name + description only — no gate, no allowed-tools");
  assert.match(SOURCE, /^name: playwright-wrapper$/m);
  // The body is bounded: it is a router to the bin, not a second copy of the
  // README. Anything deeper belongs behind the README pointer at the end.
  const body = lines.length - (close + 1);
  assert.ok(body <= 100, `skill body stays under ~100 lines (got ${body})`);
});

test("the description fires on the four intents and excludes running an existing suite", () => {
  const description = SOURCE.match(/^description: (.+)$/m)[1];
  assert.match(description, /E2E test/i, "intent: write a test from a description");
  assert.match(description, /\bCI\b/, "intent: a test broke in CI");
  assert.match(description, /extract/i, "intent: extract structured data");
  assert.match(description, /(fetch|read)/i, "intent: read a page the session cannot reach");
  assert.match(description, /npx playwright test/, "and it points 'run the tests' away from itself");
});

test("the skill body keeps the plan gate as two turns", () => {
  assert.match(SOURCE, /Never run `generate` in the same turn as `plan`/);
  assert.match(SOURCE, /WRAPPER_OLLAMA_API_KEY/, "the one required env var is named");
});

test("the injectable body surfaces SkillError rather than throwing raw fs errors", (t) => {
  assert.throws(
    () => runSkillInstall({ home: scratchHome(t), packageRoot: "/nonexistent" }),
    (err) => err instanceof SkillError && /cannot read the packaged skill/.test(err.message),
  );
});
