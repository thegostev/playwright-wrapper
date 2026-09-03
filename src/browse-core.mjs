// Browse core (FYR-333): the planless ReAct loop over the live page.
//
// Browsing is planless by contract (FYR-254/251): no plan is ever created for
// the browsing profile. The loop drives the in-process bridge's core tools and
// ends ONLY on the terminal `submit_extraction` tool call — the one call that
// can end the loop. The extracted payload is classified against the declared
// JSON Schema (when given):
//
//   schema present + payload conforms (+ optional assertions pass) → verified
//   no schema (payload parses)                                    → asserted
//   terminal call unparseable                                     → malformed_submit (not_pass)
//
// The outcome envelope (contract_version 2, FYR-259 + FYR-265) carries
// `outcome_class` (pass | pass_with_warning | not_pass) and the outcome enum
// value. Confidence scores never route anything (FYR-259). The loop reuses
// the bridge's click-recovery (the network-idle gotcha). Runaway is capped
// with an outcome (`no_terminal_call`), not an exception.
//
// The v1 core covers the structural oracle paths. Empty three-state handling,
// the identity judge, and the coverage_incomplete gate are FYR-334 (oracle
// hardening) and are NOT in this module.

import { completeChat } from "../src/llm-client.mjs";
import { BrowserBridge, hrefOfRef, resolveHref, currentUrl } from "../src/browser-bridge.mjs";

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

const OUTCOME_CLASS = Object.freeze({
  verified: "pass",
  asserted: "pass_with_warning",
  schema_failed: "not_pass",
  malformed_submit: "not_pass",
  no_terminal_call: "not_pass",
  tool_error: "not_pass",
});

/**
 * The planless ReAct loop.
 *
 * @param {object} opts
 * @param {object} opts.spec - parsed browsing task spec {header, goal}
 * @param {object} opts.config - LLM config
 * @param {object} [opts.bridge] - injected bridge (tests); default real one
 * @param {string} [opts.cannedResponses] - stub mode (tests): array of model
 *        responses to serve in order (content or tool_calls); when given the
 *        real LLM and browser are not used
 * @param {object} [opts.schema] - parsed JSON Schema (declared expected output)
 * @returns {Promise<object>} the outcome envelope (contract_version 2)
 */
export async function runBrowseLoop({ spec, config, bridge = null, cannedResponses = null, schema = null, maxSteps = MAX_STEPS } = {}) {
  const attempts = { n_primary: 0, n_fallback: 0, third_tier: { attempted: false, used: false } };
  const history = [];
  const trace = [];

  const terminal = (outcome, extra = {}) => ({
    contract_version: 2,
    outcome,
    structural_outcome: outcome,
    outcome_class: OUTCOME_CLASS[outcome] ?? "not_pass",
    task_id: spec.header.taskId ?? null,
    url: spec.header.target,
    attempts,
    outcome_history: history,
    escalation: null,
    coverage: { rows_extracted: null, last_page_reached: null, stated_total_reported: null, stated_total_parsed: null },
    notes: "",
    ...extra,
  });

  // Canned mode (tests): pure transcript-driven classification.
  if (cannedResponses !== null) {
    for (const raw of cannedResponses) {
      const turn = JSON.parse(raw);
      if (turn.tool === "submit_extraction") {
        const submission = turn;
        history.push({ tool: "submit_extraction" });
        attempts.n_primary += 1;
        // Mechanical rule (FYR-259): a submit that parses at all → the schema
        // path; only an unparseable terminal call is malformed_submit.
        if (submission.unparseable) {
          return terminal("malformed_submit", {
            error: { stage: "submit", tool: "submit_extraction", message: "the terminal call's arguments were not parseable JSON" },
          });
        }
        if (!schema) {
          return terminal("asserted", { data: submission.data });
        }
        const problems = schemaViolations(submission.data, schema);
        if (problems.length > 0) {
          return terminal("schema_failed", {
            schema: { failed_fields: problems.map((p) => ({ field: p, expected: "conforming", received: "violating", raw: null, raw_truncated: false })) },
          });
        }
        return terminal("verified", { data: submission.data });
      }
      history.push({ tool: turn.tool });
      attempts.n_primary += 1;
    }
    // Ran out of canned responses without a terminal call.
    attempts.n_primary += 0;
    return terminal("no_terminal_call", {
      error: { stage: "submit", tool: null, message: `the loop hit the ${maxSteps}-step cap without a terminal submit_extraction call` },
    });
  }

  // Live mode: bridge + LLM.
  const own = bridge === null;
  const b = bridge ?? new BrowserBridge();

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
        return terminal("tool_error", {
          error: { stage: "submit", tool: "llm", message: `LLM call failed: ${err.message}` },
        });
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
          if (!argsOk) {
            history.push({ tool: "submit_extraction", malformed: true });
            return terminal("malformed_submit", {
              error: { stage: "submit", tool: "submit_extraction", message: "the terminal call's arguments were not parseable JSON" },
            });
          }
          history.push({ tool: "submit_extraction" });
          if (!schema) {
            return terminal("asserted", { data: args.data ?? null, notes: typeof args.notes === "string" ? args.notes : "" });
          }
          const problems = schemaViolations(args.data, schema);
          if (problems.length > 0) {
            return terminal("schema_failed", {
              schema: { failed_fields: problems.map((p) => ({ field: p, expected: "conforming", received: "violating", raw: null, raw_truncated: false })) },
            });
          }
          return terminal("verified", { data: args.data ?? null, notes: typeof args.notes === "string" ? args.notes : "" });
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
          trace.push({ step, tool: name, error: err.message });
          messages.push({ role: "tool", tool_call_id: tc.id, content: `ERROR: ${err.message}` });
          continue;
        }
        trace.push({ step, tool: name, ok: true });
        messages.push({ role: "tool", tool_call_id: tc.id, content: resultText });
      }
    }

    // Cap reached without a terminal call → outcome, not an exception.
    return terminal("no_terminal_call", {
      error: { stage: "submit", tool: null, message: `the loop hit the ${maxSteps}-step cap without a terminal submit_extraction call` },
    });
  } finally {
    if (own) await b.close().catch(() => {});
  }
}