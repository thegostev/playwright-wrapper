// `skill` subcommand (LAG-574): install the canonical skill/SKILL.md into the
// session's global skill directory.
//
//   skill install [--force] [--print]
//
// The installed copy is stamped with the package version, so a skill that has
// drifted from the bin it documents is detectable rather than silent. The
// stamp is the last line of the file and is not part of the body:
//
//   <!-- playwright-wrapper skill v1.0.0 -->
//
// Three outcomes when the target already exists, decided on the BODY (the file
// minus its stamp), never on raw bytes:
//   - body same, stamp same       -> already current, nothing written, exit 0
//   - body same, stamp differs    -> upgrade in place, naming both versions
//   - body differs (local edits)  -> refuse, naming installed vs package
//                                    version; --force overwrites
// Exit codes match the rest of the surface: 0 ok, 1 error, 2 usage.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class SkillError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.name = "SkillError";
    this.exitCode = exitCode;
  }
}

const PACKAGE_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const SKILL_NAME = "playwright-wrapper";
const STAMP_RE = /^<!-- playwright-wrapper skill v(.+) -->$/;

const USAGE = `playwright-wrapper skill — install the Claude Code skill

Usage:
  playwright-wrapper skill install [--force] [--print]

Copies the packaged skill to ~/.claude/skills/${SKILL_NAME}/SKILL.md, stamped
with the package version. Refuses to overwrite a locally edited copy without
--force. --print writes the stamped skill to stdout and touches nothing.`;

/** Split a stamped file into its body and the version the stamp names. */
export function splitStamp(text) {
  const lines = text.split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const match = lines.length ? lines[lines.length - 1].match(STAMP_RE) : null;
  if (match) {
    lines.pop();
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return { body: lines.join("\n") + "\n", version: match[1] };
  }
  return { body: lines.join("\n") + "\n", version: null };
}

/** Append the version stamp to a body, idempotently. */
export function applyStamp(body, version) {
  const { body: bare } = splitStamp(body);
  return `${bare}\n<!-- playwright-wrapper skill v${version} -->\n`;
}

/**
 * The install body, injectable for tests.
 * @param {object} opts
 * @param {string} [opts.home] - the home directory holding .claude/
 * @param {string} [opts.packageRoot] - package root holding skill/SKILL.md
 * @param {boolean} [opts.force] - overwrite a locally edited copy
 * @param {boolean} [opts.print] - write to stdout instead of the filesystem
 * @returns {{stdout: string, stderr: string, target: string, action: string}}
 */
export function runSkillInstall({
  home,
  packageRoot = PACKAGE_ROOT,
  force = false,
  print = false,
} = {}) {
  const sourcePath = path.join(packageRoot, "skill", "SKILL.md");
  let source;
  try {
    source = readFileSync(sourcePath, "utf8");
  } catch (err) {
    throw new SkillError(`cannot read the packaged skill at ${sourcePath}: ${err.message}`);
  }

  let version;
  try {
    version = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
  } catch (err) {
    throw new SkillError(`cannot read the package version: ${err.message}`);
  }
  if (typeof version !== "string" || version.trim() === "") {
    throw new SkillError("package.json has no version — the installed skill cannot be stamped");
  }

  const stamped = applyStamp(source, version);
  if (print) return { stdout: stamped, stderr: "", target: null, action: "print" };

  const root = home || process.env.HOME || homedir();
  const dir = path.join(root, ".claude", "skills", SKILL_NAME);
  const target = path.join(dir, "SKILL.md");

  if (existsSync(target)) {
    let existing;
    try {
      existing = readFileSync(target, "utf8");
    } catch (err) {
      throw new SkillError(`cannot read the installed skill at ${target}: ${err.message}`);
    }
    const installed = splitStamp(existing);
    const packaged = splitStamp(stamped);
    const named = installed.version ?? "unstamped";

    if (installed.body === packaged.body) {
      if (installed.version === version) {
        return {
          stdout: `playwright-wrapper skill: already current at ${target} (v${version})\n`,
          stderr: "",
          target,
          action: "current",
        };
      }
      // Same body, different stamp: a clean package upgrade. Replace, and say so.
      write(dir, target, stamped);
      return {
        stdout: `playwright-wrapper skill: upgraded ${target} (${named} -> v${version})\n`,
        stderr: "",
        target,
        action: "upgraded",
      };
    }

    if (!force) {
      throw new SkillError(
        `${target} has been edited since it was installed (installed ${named}, package v${version}) — ` +
          `re-run with --force to replace it, or with --print to see what would be written`,
      );
    }
    write(dir, target, stamped);
    return {
      stdout: `playwright-wrapper skill: replaced ${target} (${named} -> v${version}, --force)\n`,
      stderr: "",
      target,
      action: "forced",
    };
  }

  write(dir, target, stamped);
  return {
    stdout: `playwright-wrapper skill: installed ${target} (v${version})\n`,
    stderr: "",
    target,
    action: "installed",
  };
}

function write(dir, target, contents) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, contents, "utf8");
  } catch (err) {
    throw new SkillError(`cannot write ${target}: ${err.message}`);
  }
}

/** The bin path: argv after `skill`. Returns the process exit code. */
export async function skillMain(argv) {
  const [action, ...flags] = argv;

  if (action === undefined) {
    process.stderr.write("playwright-wrapper skill: missing action\n\n" + USAGE + "\n");
    return 2;
  }
  if (action !== "install") {
    process.stderr.write(
      `playwright-wrapper skill: unknown action "${action}"\n\n` + USAGE + "\n",
    );
    return 2;
  }

  const known = new Set(["--force", "--print"]);
  const unknown = flags.filter((f) => !known.has(f));
  if (unknown.length) {
    process.stderr.write(
      `playwright-wrapper skill install: unknown option "${unknown[0]}"\n\n` + USAGE + "\n",
    );
    return 2;
  }

  try {
    const res = runSkillInstall({
      force: flags.includes("--force"),
      print: flags.includes("--print"),
    });
    process.stdout.write(res.stdout);
    return 0;
  } catch (err) {
    if (err instanceof SkillError) {
      process.stderr.write(`playwright-wrapper skill: ${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }
}
