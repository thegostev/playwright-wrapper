// `browse` subcommand (FYR-333): the planless ReAct loop as a product command.
//
//   browse <spec-file>   — browsing-profile task spec (browse: block optional)
//
// Parses the task spec (profile: browsing required here — plan serves test),
// optionally loads the declared JSON Schema (browse.schema path), runs the
// planless loop (src/browse-core.mjs) over the live page, and prints the
// contract_version 2 outcome envelope on stdout. Exit code mirrors the
// outcome class: pass → 0, pass_with_warning → 0 (second-class, still a
// run), not_pass → 1. No plan is ever created for the browsing profile —
// the gate stays mechanical on `profile`.

import { parseTaskSpec, TaskSpecRefusal } from "../../src/task-spec.mjs";
import { runBrowseLoop } from "../../src/browse-core.mjs";
import { loadConfig } from "../../src/config.mjs";
import { readFileSync } from "node:fs";

export class BrowseCommandError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.name = "BrowseCommandError";
    this.exitCode = exitCode;
  }
}

/**
 * The injectable body.
 * @param {object} opts
 * @param {string} opts.specText
 * @param {object} opts.config
 * @param {object} [opts.bridge] - injected bridge (tests)
 * @param {Array} [opts.cannedResponses] - stub loop transcripts (tests)
 * @param {string} [opts.schemaText] - the declared JSON Schema bytes (tests);
 *        live mode loads it from the browse.schema path itself
 * @param {string} [opts.schemaBase] - directory to resolve browse.schema
 *        against (defaults to process.cwd())
 */
export async function runBrowse({ specText, config, bridge = null, cannedResponses = null, schema, schemaBase = null } = {}) {
  let spec;
  try {
    spec = parseTaskSpec(specText);
  } catch (err) {
    if (err instanceof TaskSpecRefusal) {
      throw new BrowseCommandError(err.message, { exitCode: 2 });
    }
    throw err;
  }
  if (spec.header.profile !== "browsing") {
    throw new BrowseCommandError(
      `browse serves the browsing profile only (this spec declares profile: ${spec.header.profile}; the test profile goes through plan → gate → generate)`,
    );
  }

  // The declared JSON Schema (optional). In live mode it is a PATH (FYR-251:
  // browse.schema is a path, never inline). `schema` unset → load from the
  // declared path; null explicitly disables schema classification.
  let effectiveSchema = schema === undefined ? undefined : schema;
  if (effectiveSchema === undefined && spec.header.browse?.schema) {
    const schemaPath = resolveSchemaPath(spec.header.browse.schema, schemaBase);
    let raw;
    try {
      raw = readFileSync(schemaPath, "utf8");
    } catch (err) {
      throw new BrowseCommandError(`cannot read the declared browse.schema (${schemaPath}): ${err.message}`, { exitCode: 2 });
    }
    try {
      effectiveSchema = JSON.parse(raw);
    } catch (err) {
      throw new BrowseCommandError(`the declared browse.schema is not valid JSON: ${err.message}`, { exitCode: 2 });
    }
  }

  const envelope = await runBrowseLoop({ spec, config, bridge, cannedResponses, schema: effectiveSchema });
  return envelope;
}

function resolveSchemaPath(p, base) {
  if (/^https?:\/\//.test(p) || path.isAbsolute(p)) return p;
  return (base ?? process.cwd()) + "/" + p;
}

import path from "node:path";

export async function browseMain(argv) {
  const inlineIdx = argv.indexOf("--inline");
  let specText = null;
  if (inlineIdx !== -1) {
    specText = argv[inlineIdx + 1] ?? "";
  } else {
    const file = argv[0];
    if (!file || file.startsWith("-")) {
      process.stderr.write(
        "playwright-wrapper browse: missing spec argument\n\n" +
          "Usage: playwright-wrapper browse <spec-file>\n" +
          '       playwright-wrapper browse --inline "<full spec text>"\n',
      );
      return 2;
    }
    try {
      specText = readFileSync(file, "utf8");
    } catch (err) {
      process.stderr.write(`playwright-wrapper browse: cannot read spec file: ${err.message}\n`);
      return 2;
    }
  }

  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err?.name === "ConfigError") {
      process.stderr.write(`playwright-wrapper: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  try {
    const envelope = await runBrowse({ specText, config });
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
    return envelope.outcome_class === "not_pass" ? 1 : 0;
  } catch (err) {
    if (err instanceof BrowseCommandError) {
      process.stderr.write(`playwright-wrapper browse: ${err.message}\n`);
      return err.exitCode;
    }
    process.stderr.write(`playwright-wrapper browse: ${err.message}\n`);
    return 1;
  }
}