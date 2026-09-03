// Browse core (FYR-333 + FYR-334): the planless ReAct loop over the live page.
//
// Browsing is planless by contract (FYR-254/251): no plan is ever created for
// the browsing profile. The loop drives the in-process bridge's core tools and
// ends ONLY on the terminal `submit_extraction` tool call — the one call that
// can end the loop. Classification is the oracle's (src/browse-oracle.mjs,
// FYR-334): empty three-state under a declared allowEmpty, the optional
// page-identity judge, and the pagination hard gate computed from trace cues.
// The outcome envelope (contract_version 2, FYR-259 + FYR-265) carries
// `outcome_class` (pass | pass_with_warning | not_pass) and all twelve
// outcomes; confidence never routes; the gate is a verdict, never loop
// control. Runaway is capped with an outcome (`no_terminal_call`), not an
// exception.
//
// Live runs persist the execution trace (snapshot texts included) under
// playwright-output/<project>/browse/<run-id>/trace.json so every cue the
// gate consumed is auditable after the run; the envelope also carries a
// compact `trace`.

import { completeChat } from "../src/llm-client.mjs";
import { BrowserBridge, hrefOfRef, resolveHref, currentUrl } from "../src/browser-bridge.mjs";
import {
  isEmptyPayload,
  scanMarker,
  classifyEmpty,
  scanCues,
  paginationGate,
  parseStatedTotal,
  rowsExtracted,
  coverageSuspect,
  runIdentityJudge,
  applyOverrides,
  validateEnvelope,
  OUTCOME_CLASS,
} from "../src/browse-oracle.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export class BrowseError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.name = "BrowseError";
    this.exitCode = exitCode;
  }
}

// Runaway cap: the loop is capped with an outcome, not an exception.
const MAX_STEPS = 12;

// The bridge's core tool subset the loop exposes (FYR-258's proven set).
const BROWSER_ALLOW = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press_key",
]);

const SUBMIT_SCHEMA = {
  type: "object",
  properties: {
    data: { description: "The extracted payload, matching the expected output shape when one is declared in the spec." },
    notes: { type: "string", description: "Optional freeform notes — human-only, never read programmatically." },
  },
  required: ["data"],
};

/**
 * The system prompt: how to drive the browser, when to stop.
 */
export function browseSystemPrompt(schema, goal) {
  const schemaNote = schema
    ? `The extracted data will be validated against the JSON Schema the human declared:\n${JSON.stringify(schema, null, 2)}\nConform to it exactly.`
    : "No output schema was declared for this run — the extraction is recorded as self-asserted.";
  return `You are an autonomous browsing agent driving a real Chromium browser through tools.
Your job: ${goal}

How the browser tools work:
- browser_navigate({ url }) — go to a URL.
- browser_snapshot() — return an accessibility-tree snapshot of the page as YAML. This is your EYES: it lists every visible element with a ref like [ref=e12]. Links appear as \`- link "Link text" [ref=e7]\` with the target URL as a child \`- /url: …\` line. The snapshot is the only way to see page content.
- browser_click({ element, target }) — click the element whose ref is \`target\` (e.g. "e7"). \`element\` is a human description of what you're clicking.
- browser_type({ element, target, text }) — type text into the element whose ref is \`target\`.
- browser_press_key({ key }) — press a key (e.g. "Enter").
${schemaNote}
Rules:
- Act only through the tools. Do not invent data you did not see in a snapshot.
- Prefer fewer, high-signal snapshots.
- When you have the data the goal asks for, call submit_extraction({ data, notes? }) EXACTLY ONCE to finish. It is the only call that ends the loop. An empty result is a valid answer if the page genuinely has nothing.
- Do not call submit_extraction until you have actually collected the data.`;
}

/**
 * Build the OpenAI tool list from the bridge's real tool schemas (avoids the
 * target-vs-ref gotcha — the real schema tells the model what to send) plus
 * the terminal submit_extraction.
 */
export function buildToolList(bridgeTools) {
  const tools = bridgeTools
    .filter((t) => BROWSER_ALLOW.has(t.name))
    .map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  tools.push({
    type: "function",
    function: {
      name: "submit_extraction",
      description: "Submit the final extracted data and finish the run. Call this ONCE when you have collected what the goal asks for.",
      parameters: SUBMIT_SCHEMA,
    },
  });
  return tools;
}

/**
 * Validate the submitted data against the declared JSON Schema (subset):
 * type, required, properties, items, minItems, maxItems, enum, pattern,
 * uniqueItems. Deliberately small — the FYR-259 rule is that JSON Schema's
 * cheap assertions do the completeness/dedup work, not a judge. Returns
 * [] when conforming, otherwise a list of violation strings.
 */
export function schemaViolations(data, schema) {
  const problems = [];
  const check = (value, schemaNode, path) => {
    if (schemaNode === true || schemaNode === undefined) return;
    if (schemaNode === false) {
      problems.push(`${path || "data"}: schema forbids any value here`);
      return;
    }
    const t = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (schemaNode.type) {
      const expected = Array.isArray(schemaNode.type) ? schemaNode.type : [schemaNode.type];
      const okTypes = new Set(expected.map((x) => (x === "number" ? "number" : x === "integer" ? "number" : x)));
      const actualOk =
        (expected.includes("integer") && typeof value === "number" && Number.isInteger(value)) ||
        (okTypes.has(t) && !(expected.includes("integer") && typeof value === "number" && !Number.isInteger(value)));
      if (!actualOk) {
        problems.push(`${path || "data"}: expected type ${expected.join("|")}, got ${t}`);
        return;
      }
    }
    if (Array.isArray(value)) {
      if (typeof schemaNode.minItems === "number" && value.length < schemaNode.minItems) {
        problems.push(`${path || "data"}: expected at least ${schemaNode.minItems} items, got ${value.length}`);
      }
      if (typeof schemaNode.maxItems === "number" && value.length > schemaNode.maxItems) {
        problems.push(`${path || "data"}: expected at most ${schemaNode.maxItems} items, got ${value.length}`);
      }
      if (schemaNode.uniqueItems) {
        const seen = new Set(value.map((v) => JSON.stringify(v)));
        if (seen.size !== value.length) {
          problems.push(`${path || "data"}: uniqueItems violated (duplicates present)`);
        }
      }
      for (const [i, item] of value.entries()) check(item, schemaNode.items ?? undefined, `${path || "data"}[${i}]`);
      return;
    }
    if (t === "object" && schemaNode.properties) {
      for (const req of schemaNode.required ?? []) {
        if (!(req in value)) problems.push(`${path ? path + "." : ""}${req}: required property missing`);
      }
      for (const [key, sub] of Object.entries(schemaNode.properties)) {
        if (key in value) check(value[key], sub, `${path ? path + "." : ""}${key}`);
      }
      return;
    }
    if (typeof schemaNode.pattern === "string" && typeof value === "string") {
      if (!new RegExp(schemaNode.pattern).test(value)) {
        problems.push(`${path || "data"}: expected pattern ${schemaNode.pattern}, got ${JSON.stringify(value)}`);
      }
    }
  };
  check(data, schema, "");
  return problems;
}

// --- The identity judge, live wiring ------------------------------------------

function judgeSystemPrompt() {
  return `You are a page-identity judge for an autonomous browsing agent. You answer exactly one question about whether the page shown is the page the human intended. Judge IDENTITY ONLY — you never see and must never reason about any extracted payload.
Answer ONLY with a JSON object: {"pass": true|false, "reason": "<one sentence>", "confidence": <0..1>}.
"confidence" is recorded for humans only — it is not for routing and nothing keys on it.`;
}

/**
 * The live judge: one completion, JSON out. Any parse failure throws — the
 * caller turns a thrown judge into `ran:false` and the structural verdict
 * stands (FYR-259: a judge error never overrides a structural verdict).
 */
function liveJudgeFn(config) {
  return async ({ question, url, snapshotText }) => {
    const messages = [
      { role: "system", content: judgeSystemPrompt() },
      {
        role: "user",
        content: `Page URL: ${url}\n\nQuestion: ${question}\n\nAccessibility snapshot of the page:\n\n${snapshotText || "(no snapshot was captured during the run)"}`,
      },
    ];
    const res = await completeChat({ messages, maxTokens: 512, config });
    return parseJudgeJson(res.message?.content ?? "");
  };
}

function parseJudgeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("the judge's answer was not parseable JSON");
  }
}

// --- The page probe (empty-path page reads) ------------------------------------
//
// FYR-259: both empty paths read page text AFTER network-idle (never the
// placeholder). The probe's reads are fresh snapshots taken after the loop's
// navigation settled — the MCP bridge returns snapshots only once the page
// has loaded, so a fresh read is the post-network-idle read.
//
// The recheck is ONE fixed in-oracle re-read (scroll to the end, re-snapshot)
// — never 250's retry policy, never configurable.

function liveProbe(bridge) {
  return {
    readPageText: async () => bridge.snapshot(),
    recheck: async () => {
      await bridge.callTool("browser_press_key", { key: "End" });
      return bridge.snapshot();
    },
  };
}

const NO_PROBE = {
  readPageText: async () => {
    throw new Error("no page probe available for the empty-path read");
  },
  recheck: async () => {
    throw new Error("no page probe available for the empty-path recheck");
  },
};

// --- Trace persistence ---------------------------------------------------------

/** The consumer repo's *name* (git remote basename, else the cwd's name). */
export function projectName(cwd = process.cwd()) {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const m = url.match(/\/([^\/]+?)(?:\.git)?\/?$/);
    if (m) return m[1];
  } catch {
    /* not a repo / no origin — fall through */
  }
  return path.basename(cwd);
}

/**
 * Persist the execution trace (full snapshot texts included) so every cue the
 * gate consumed is auditable after the run. Audit-only: a write failure is
 * reported on stderr, never fails the run.
 */
function persistTrace({ cwd, spec, trace, oracleReads, envelope }) {
  let tracePath = null;
  try {
    const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dir = path.join(cwd, "playwright-output", projectName(cwd), "browse", runId);
    mkdirSync(dir, { recursive: true });
    tracePath = path.join(dir, "trace.json");
    writeFileSync(
      tracePath,
      JSON.stringify(
        {
          run_id: runId,
          url: spec.header.target,
          task_id: spec.header.taskId ?? null,
          trace,
          oracle_reads: oracleReads,
          envelope,
        },
        null,
        2,
      ) + "\n",
    );
  } catch (err) {
    process.stderr.write(`playwright-wrapper browse: could not persist the execution trace (run continues): ${err.message}\n`);
  }
  return tracePath;
}

/**
 * Classify the terminal submit through the oracle and assemble the final
 * envelope. Structural classification first (empty three-state / schema path /
 * error passthrough), then judge + coverage + pagination gates + overrides,
 * then normative presence validation (the oracle never ships an envelope that
 * violates its own contract).
 */
async function classifyAndAssemble({
  spec,
  data,
  notes,
  schema,
  allowEmpty,
  identityQuestion,
  trace,
  judgeFn,
  probe,
  oracleReads,
  errorOverride = null,
}) {
  let structuralOutcome;
  let structuralClass = "not_pass";
  let extra = {};
  let errored = Boolean(errorOverride);

  if (errorOverride) {
    // malformed_submit / tool_error / no_terminal_call paths bypass the
    // oracle (nothing to judge, nothing to gate).
    structuralOutcome = errorOverride.outcome;
    extra = { error: errorOverride.error };
  } else if (isEmptyPayload(data)) {
    // Empty path: page-text marker scan (fresh, post-network-idle read), then
    // ONE fixed recheck when unmarked, then the three-state verdict. minItems
    // is an absolute floor the marker never overrides.
    let marker = null;
    let recheck = null;
    let probeError = null;
    try {
      const text = await probe.readPageText();
      oracleReads.push({ kind: "marker_scan", text });
      marker = scanMarker(text);
    } catch (err) {
      probeError = `empty-path page read failed: ${err.message}`;
    }
    if (!probeError && !marker.found) {
      try {
        const text = await probe.recheck();
        oracleReads.push({ kind: "recheck", text });
        recheck = scanMarker(text);
      } catch (err) {
        probeError = `empty-path recheck failed: ${err.message}`;
      }
    }
    if (probeError) {
      structuralOutcome = "tool_error";
      errored = true;
      extra = { error: { stage: "recheck", tool: null, message: probeError } };
    } else {
      const verdict = classifyEmpty({ allowEmpty, schema, marker, recheck });
      structuralOutcome = verdict.outcome;
      structuralClass = OUTCOME_CLASS[structuralOutcome];
      extra = { empty: verdict.empty };
      if (verdict.schema) extra.schema = verdict.schema;
    }
  } else if (!schema) {
    structuralOutcome = "asserted";
    structuralClass = "pass_with_warning";
  } else {
    const problems = schemaViolations(data, schema);
    if (problems.length > 0) {
      structuralOutcome = "schema_failed";
      structuralClass = "not_pass";
      extra = { schema: { failed_fields: problems.map((p) => ({ field: p, expected: "conforming", received: "violating", raw: null, raw_truncated: false })) } };
    } else {
      structuralOutcome = "verified";
      structuralClass = "pass";
    }
  }

  // Judge: page-identity only, on pass-path structural outcomes, input =
  // snapshot + URL (never the payload). A judge error never overrides.
  const cues = scanCues(trace);
  let judge = null;
  if (identityQuestion && !errored && structuralClass !== "not_pass") {
    judge = await runIdentityJudge({
      question: identityQuestion,
      url: spec.header.target,
      snapshotText: cues.lastSnapshot,
      judge: judgeFn,
    });
  }

  // Coverage telemetry + gates. Model-authored numbers are `_reported` and
  // diagnostic-only (no wire source for them in v1 — nullable); every
  // arithmetic reads the harness-parsed twin; absent total → no arithmetic.
  const rows = errored ? null : rowsExtracted(data);
  const statedTotalParsed = cues.lastSnapshot !== null ? parseStatedTotal(cues.lastSnapshot) : null;
  const statedTotalReported = null;
  const coverage = {
    rows_extracted: rows,
    last_page_reached_reported: null,
    stated_total_reported: statedTotalReported,
    stated_total_parsed: statedTotalParsed,
    stated_total_disagreement: statedTotalReported === null ? null : statedTotalReported !== statedTotalParsed,
  };
  const suspect = coverageSuspect({ outcome_class: structuralClass, rows, statedTotalParsed });
  const pg = paginationGate(cues);

  const applied = applyOverrides({
    structuralOutcome,
    structuralClass,
    judge,
    pagination: pg,
    suspect,
  });

  // The payload contract's presence rules are STRUCTURAL: empty/schema key on
  // structural_outcome even when an override renames the final outcome. An
  // errored run (malformed_submit / tool_error / no_terminal_call) carries
  // neither block.
  const envelope = {
    contract_version: 2,
    outcome: applied.outcome,
    structural_outcome: structuralOutcome,
    outcome_class: applied.outcome_class,
    task_id: spec.header.taskId ?? null,
    url: spec.header.target,
    attempts: { n_primary: 0, n_fallback: 0, third_tier: { attempted: false, used: false } },
    outcome_history: [],
    escalation: null,
    empty: errored ? null : extra.empty ?? null,
    schema: errored ? null : extra.schema ?? null,
    semantic: applied.semantic,
    pagination: applied.pagination,
    coverage,
    error: extra.error ?? null,
    data: errored ? null : data ?? null,
    notes: typeof notes === "string" ? notes : "",
    trace: [],
    trace_path: null,
  };

  const bad = validateEnvelope(envelope);
  if (bad.length > 0) {
    throw new Error(`oracle internal error: the outcome envelope violates its own contract — ${bad.join("; ")}`);
  }
  return { envelope, cues };
}

/**
 * The planless ReAct loop.
 *
 * @param {object} opts
 * @param {object} opts.spec - parsed browsing task spec {header, goal}
 * @param {object} opts.config - LLM config
 * @param {object} [opts.bridge] - injected bridge (tests); default real one
 * @param {Array} [opts.cannedResponses] - stub mode (tests): array of model
 *        responses to serve in order ({tool: name} with optional {text} for
 *        snapshot results, {target, element} for clicks); when given the real
 *        LLM and browser are not used
 * @param {object} [opts.schema] - parsed JSON Schema (declared expected output)
 * @param {boolean} [opts.allowEmpty] - the declared empty tolerance (coerced
 *        from the spec's browse.allowEmpty by the command layer)
 * @param {string|null} [opts.identityQuestion] - the opt-in identity question
 * @param {Function} [opts.judge] - injected judge (tests); live mode builds
 *        one over the configured LLM
 * @param {object} [opts.pageProbe] - injected page probe (tests):
 *        {readPageText, recheck}; live mode probes through the bridge
 * @param {boolean} [opts.persist] - persist the execution trace (live mode;
 *        default true — canned/stub runs never persist)
 * @param {string} [opts.cwd] - persistence root (defaults to process.cwd())
 * @returns {Promise<object>} the outcome envelope (contract_version 2)
 */
export async function runBrowseLoop({
  spec,
  config,
  bridge = null,
  cannedResponses = null,
  schema = null,
  allowEmpty = false,
  identityQuestion = null,
  judge = null,
  pageProbe = null,
  persist = true,
  cwd = process.cwd(),
  maxSteps = MAX_STEPS,
} = {}) {
  const attempts = { n_primary: 0, n_fallback: 0, third_tier: { attempted: false, used: false } };
  const history = [];
  const trace = [];
  const oracleReads = [];

  // Canned mode (tests): pure transcript-driven classification. Entries may
  // be JSON strings (the FYR-333 helper shape) or plain objects.
  if (cannedResponses !== null) {
    for (const raw of cannedResponses) {
      const turn = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (turn.tool === "submit_extraction") {
        history.push({ tool: "submit_extraction" });
        attempts.n_primary += 1;
        // Mechanical rule (FYR-259): a submit that parses at all → the schema
        // path; only an unparseable terminal call is malformed_submit.
        if (turn.unparseable) {
          return finish(
            await classifyAndAssemble({
              spec,
              data: null,
              notes: "",
              schema,
              allowEmpty,
              identityQuestion,
              trace,
              judgeFn: judge,
              probe: pageProbe ?? NO_PROBE,
              oracleReads,
              errorOverride: {
                outcome: "malformed_submit",
                error: { stage: "submit", tool: "submit_extraction", message: "the terminal call's arguments were not parseable JSON" },
              },
            }),
            { attempts, history, trace },
          );
        }
        const env = await classifyAndAssemble({
          spec,
          data: turn.data,
          notes: typeof turn.notes === "string" ? turn.notes : "",
          schema,
          allowEmpty,
          identityQuestion,
          trace,
          judgeFn: judge,
          probe: pageProbe ?? NO_PROBE,
          oracleReads,
        });
        return finish(env, { attempts, history, trace });
      }
      history.push({ tool: turn.tool });
      attempts.n_primary += 1;
      trace.push(recordCannedTurn(turn));
    }
    // Ran out of canned responses without a terminal call.
    return finish(
      await classifyAndAssemble({
        spec,
        data: null,
        notes: "",
        schema,
        allowEmpty,
        identityQuestion,
        trace,
        judgeFn: judge,
        probe: pageProbe ?? NO_PROBE,
        oracleReads,
        errorOverride: {
          outcome: "no_terminal_call",
          error: { stage: "submit", tool: null, message: `the loop hit the ${maxSteps}-step cap without a terminal submit_extraction call` },
        },
      }),
      { attempts, history, trace },
    );
  }

  // Live mode: bridge + LLM.
  const own = bridge === null;
  const b = bridge ?? new BrowserBridge();
  const live = {
    judgeFn: judge ?? (identityQuestion ? liveJudgeFn(config) : null),
    probe: pageProbe ?? liveProbe(b),
  };

  try {
    if (own) await b.warmContext();
    await b.navigate(spec.header.target);

    const bridgeTools = await b.listTools();
    const tools = buildToolList(bridgeTools);
    const messages = [
      { role: "system", content: browseSystemPrompt(schema, spec.goal) },
      { role: "user", content: `Browse and extract now. Start from the page you are on. Goal: ${spec.goal}` },
    ];

    for (let step = 1; step <= maxSteps; step++) {
      let res;
      try {
        res = await completeChat({ messages, tools, maxTokens: 4096, config });
      } catch (err) {
        return finish(
          await classifyAndAssemble({
            spec,
            data: null,
            notes: "",
            schema,
            allowEmpty,
            identityQuestion,
            trace,
            judgeFn: live.judgeFn,
            probe: live.probe,
            oracleReads,
            errorOverride: { outcome: "tool_error", error: { stage: "submit", tool: "llm", message: `LLM call failed: ${err.message}` } },
          }),
          { attempts, history, trace, persistOpts: { spec, trace, oracleReads, cwd, persist } },
        );
      }
      attempts.n_primary += 1;
      trace.push({ step, model: res.model, finish: res.finish, tool_calls: res.toolCalls.map((tc) => tc.function?.name) });

      const assistantMsg = { role: "assistant", content: res.message?.content ?? "", tool_calls: res.toolCalls.length ? res.toolCalls : undefined };
      messages.push(assistantMsg);

      const calls = res.toolCalls ?? [];
      if (calls.length === 0) {
        // No terminal call: one nudge inside the same step budget (FYR-258's
        // proven shape), then keep looping — the cap is the outcome, not an
        // exception.
        messages.push({
          role: "user",
          content: "You stopped without calling submit_extraction. Either keep browsing with the tools, or call submit_extraction now with the data you have.",
        });
        continue;
      }

      for (const tc of calls) {
        const name = tc.function?.name;
        let args = {};
        let argsOk = true;
        try {
          args = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          argsOk = false;
        }
        if (name === "submit_extraction") {
          // Mechanical rule: parses at all → schema path; unparseable → malformed_submit.
          history.push({ tool: "submit_extraction" });
          if (!argsOk) {
            return finish(
              await classifyAndAssemble({
                spec,
                data: null,
                notes: "",
                schema,
                allowEmpty,
                identityQuestion,
                trace,
                judgeFn: live.judgeFn,
                probe: live.probe,
                oracleReads,
                errorOverride: {
                  outcome: "malformed_submit",
                  error: { stage: "submit", tool: "submit_extraction", message: "the terminal call's arguments were not parseable JSON" },
                },
              }),
              { attempts, history, trace, persistOpts: { spec, trace, oracleReads, cwd, persist } },
            );
          }
          const env = await classifyAndAssemble({
            spec,
            data: args.data ?? null,
            notes: typeof args.notes === "string" ? args.notes : "",
            schema,
            allowEmpty,
            identityQuestion,
            trace,
            judgeFn: live.judgeFn,
            probe: live.probe,
            oracleReads,
          });
          return finish(env, { attempts, history, trace, persistOpts: { spec, trace, oracleReads, cwd, persist } });
        }

        // Browser tool: execute through the bridge.
        let resultText;
        try {
          if (name === "browser_click" && args.target) {
            // The bridge's recovery encodes the network-idle gotcha; click
            // through it so a navigational click that never settles is
            // followed by a direct href navigation instead of a dead end.
            try {
              resultText = await b.click(args.target, args.element);
            } catch (err) {
              if (!err.timedOut) throw err;
              // timed-out click: recover via the pre-click snapshot's href
              const snap = await b.snapshot();
              const href = hrefOfRef(snap, args.target);
              if (href) {
                const rec = await b.recoverByHref({ href, baseUrl: currentUrl(snap) ?? spec.header.target });
                resultText = rec.text;
              } else {
                resultText = await b.snapshot();
              }
            }
          } else {
            resultText = await b.callTool(name, args);
          }
        } catch (err) {
          trace.push({ step, tool: name, ok: false, error: err.message, args: { element: args.element, target: args.target } });
          messages.push({ role: "tool", tool_call_id: tc.id, content: `ERROR: ${err.message}` });
          continue;
        }
        trace.push(recordLiveTurn({ step, name, args, resultText }));
        messages.push({ role: "tool", tool_call_id: tc.id, content: resultText });
      }
    }

    // Cap reached without a terminal call → outcome, not an exception.
    return finish(
      await classifyAndAssemble({
        spec,
        data: null,
        notes: "",
        schema,
        allowEmpty,
        identityQuestion,
        trace,
        judgeFn: live.judgeFn,
        probe: live.probe,
        oracleReads,
        errorOverride: {
          outcome: "no_terminal_call",
          error: { stage: "submit", tool: null, message: `the loop hit the ${maxSteps}-step cap without a terminal submit_extraction call` },
        },
      }),
      { attempts, history, trace, persistOpts: { spec, trace, oracleReads, cwd, persist } },
    );
  } finally {
    if (own) await b.close().catch(() => {});
  }
}

/** Compact the canned turn into a trace entry (full snapshot text retained). */
function recordCannedTurn(turn) {
  if (turn.tool === "browser_snapshot") return { tool: "browser_snapshot", text: typeof turn.text === "string" ? turn.text : "" };
  if (turn.tool === "browser_click") return { tool: "browser_click", ok: true, target: turn.target ?? null, element: turn.element ?? null };
  return { tool: turn.tool, ok: true };
}

/** Compact the live turn into a trace entry; snapshot results keep their text. */
function recordLiveTurn({ step, name, args, resultText }) {
  const entry = { step, tool: name, ok: true };
  if (name === "browser_snapshot") entry.text = resultText;
  if (name === "browser_click") {
    entry.target = args.target ?? null;
    entry.element = args.element ?? null;
  }
  return entry;
}

/** Stamp the loop-level counters, compact the trace, persist when live. */
function finish(classified, { attempts, history, trace, persistOpts }) {
  const env = classified.envelope;
  env.attempts = attempts;
  env.outcome_history = history;
  env.trace = trace.map((entry) => {
    if (entry.model !== undefined) return { step: entry.step, model: entry.model, finish: entry.finish, tool_calls: entry.tool_calls };
    const out = { step: entry.step, tool: entry.tool, ok: entry.ok };
    if (entry.error !== undefined) out.error = entry.error;
    if (entry.target !== undefined) out.target = entry.target;
    if (entry.element !== undefined) out.element = entry.element;
    return out;
  });
  if (persistOpts?.persist) {
    env.trace_path = persistTrace({ ...persistOpts, envelope: env });
  }
  return env;
}