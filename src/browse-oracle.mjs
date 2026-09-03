// Browse oracle (FYR-334): the part of the verdict the model cannot forge.
//
// FYR-259 + FYR-265 contracts, implemented harness-side:
//  - Empty handling is three-state under a declared allowEmpty. The marker
//    scan reads page text AFTER network-idle (never the model's claim), and
//    minItems is an absolute floor the marker never overrides.
//  - The identity judge is page-identity only: its input is snapshot + URL,
//    never the payload; a judge error never overrides a structural verdict.
//  - Pagination completeness is a hard gate computed from TRACE CUES only —
//    a parsed `k of n` or a Next the loop actually followed. A Next that
//    merely sits on the page is not a cue. Contradictory cues fire (union).
//    Unparseable terminal evidence fails open (never fires).
//  - Every model-authored number carries the `_reported` suffix and is
//    diagnostic-only; all arithmetic reads the harness-parsed twin, and an
//    absent total means no arithmetic (FYR-265's decoration fix).
//  - Confidence never routes. Nothing here retries: the gate is a verdict;
//    pre-terminal continuation is FYR-250's loop control.
//
// Pure module: no I/O, no model calls. The caller supplies snapshot texts
// and (for the empty path) a page probe; the judge is a callback.

// --- Empty handling ---------------------------------------------------------

// Generic negative markers (FYR-259's evidence classes, kept short and
// case-insensitive). Matched as substrings of the page text.
const NEGATIVE_MARKERS = [
  "no open positions",
  "no open roles",
  "no jobs found",
  "no results found",
  "no results",
  "0 results",
  "no positions",
  "no items",
  "no data available",
  "nothing found",
  "check back",
];

/**
 * Scan page text for a negative marker. Returns {found, text} — text is the
 * matched marker string when found.
 */
export function scanMarker(pageText) {
  const t = String(pageText ?? "");
  for (const marker of NEGATIVE_MARKERS) {
    if (t.toLowerCase().includes(marker)) return { found: true, text: marker };
  }
  return { found: false, text: null };
}

/**
 * Is the submitted payload empty by contract? null, [], or a plain object
 * every property of which is null or an empty array. A non-empty scalar
 * anywhere makes the payload non-empty — emptiness must be unambiguous to
 * reach the empty path at all.
 */
export function isEmptyPayload(data) {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data !== "object") return false;
  return Object.values(data).every((v) => v === null || v === undefined || (Array.isArray(v) && v.length === 0));
}

/**
 * The strictest minItems any array node in the schema declares — the absolute
 * floor. Returns 0 when the schema states none (top-level array, properties,
 * items are all scanned).
 */
export function schemaMinItems(schema) {
  let max = 0;
  const walk = (node) => {
    if (!node || typeof node !== "object" || node === true || node === false) return;
    if (typeof node.minItems === "number") max = Math.max(max, node.minItems);
    if (Array.isArray(node.items)) for (const it of node.items) walk(it);
    else walk(node.items);
    for (const sub of Object.values(node.properties ?? {})) walk(sub);
    for (const sub of Object.values(node.patternProperties ?? {})) walk(sub);
    for (const sub of node.additionalProperties ?? []) if (typeof sub === "object") walk(sub);
    for (const key of ["allOf", "anyOf", "oneOf"]) for (const sub of node[key] ?? []) walk(sub);
  };
  walk(schema);
  return max;
}

/**
 * The three-state empty verdict (FYR-259), given the page evidence.
 *
 * @param {object} args
 * @param {boolean} args.allowEmpty - the declared empty tolerance (coerced from the spec)
 * @param {object|null} args.schema - declared JSON Schema or null
 * @param {{found: boolean, text: string|null}} args.marker - scan of the page text (post-network-idle read)
 * @param {object|null} args.recheck - null, or the recheck's marker scan {found, text}
 * @returns {{outcome: string, empty: object, schema?: object}}
 *   outcome ∈ {empty_confirmed, empty_unconfirmed, empty_schema_conflict}
 */
export function classifyEmpty({ allowEmpty, schema, marker, recheck = null }) {
  // The schema, when declared, is the contract: minItems is an ABSOLUTE floor
  // the marker never overrides (and allowEmpty never overrides either — a
  // minItems>0 schema plus allowEmpty:true is itself a conflict to surface).
  // allowEmpty grants tolerance only where the schema is silent (absent).
  const floor = schemaMinItems(schema);
  const floorAllowsEmpty = schema === null ? allowEmpty === true : floor === 0;
  const markerScan = recheck && !marker.found ? recheck : marker;
  const recheckAttempted = recheck !== null;

  if (markerScan.found && floorAllowsEmpty) {
    return {
      outcome: "empty_confirmed",
      empty: { marker_found: true, marker_text: markerScan.text, recheck_attempted: recheckAttempted },
    };
  }
  if (markerScan.found) {
    // Marker-vs-contract contradiction: stale schema or filter false-positive.
    // Both need a human; indistinguishable in-loop (FYR-259).
    return {
      outcome: "empty_schema_conflict",
      empty: { marker_found: true, marker_text: markerScan.text, recheck_attempted: recheckAttempted },
      schema: {
        failed_fields: [
          schema === null
            ? {
                field: "allowEmpty",
                expected: "declared (or schema minItems: 0) — minItems is an absolute floor the marker never overrides",
                received: "not declared",
                raw: null,
                raw_truncated: false,
              }
            : {
                field: "minItems",
                expected: `at least ${floor} item(s) — an absolute floor no marker or allowEmpty overrides`,
                received: `page is empty (marker: "${markerScan.text}")`,
                raw: null,
                raw_truncated: false,
              },
        ],
      },
    };
  }
  // No marker anywhere (pre- or post-recheck) → emptiness unconfirmed.
  return {
    outcome: "empty_unconfirmed",
    empty: { marker_found: false, marker_text: null, recheck_attempted: recheckAttempted },
  };
}

// --- Pagination cue scanner (FYR-265) ----------------------------------------

/**
 * All `k of n` PAGER-PROGRESS parses in a snapshot text ("page 3 of 10",
 * "Showing 3 of 10 pages"). Row totals are a different cue — see
 * parseStatedTotal. Returns [{k, n}] in order of appearance.
 */
export function parsePagerProgress(text) {
  const out = [];
  const re = /(?:page|showing)\s+(\d+)\s+of\s+(\d+)(?:\s+pages?)?|(\d+)\s+of\s+(\d+)\s+pages?/gi;
  for (const m of String(text ?? "").matchAll(re)) {
    const k = Number(m[1] ?? m[3]);
    const n = Number(m[2] ?? m[4]);
    if (Number.isInteger(k) && Number.isInteger(n) && k >= 1 && n >= k) out.push({ k, n });
  }
  return out;
}

/**
 * The stated ROW total, harness-parsed from page text — the only input to the
 * 0.9 coverage check (FYR-265). Recognized forms:
 *   "Results 1–18 of 18" / "1 - 18 of 18"  → 18
 *   "of 66 jobs|results|roles|items|positions|openings" → 66
 * Returns the number, or null when the page states no parseable total
 * (no arithmetic is then possible — degrades to no signal, never a guess).
 */
export function parseStatedTotal(text) {
  const t = String(text ?? "");
  let m = t.match(/\d+\s*(?:[–—-]|to)\s*\d+\s+of\s+(\d+)/i);
  if (m) return Number(m[1]);
  m = t.match(/of\s+(\d+)\s+(?:jobs?|results?|roles?|items?|positions?|openings?|vacanc\w+)/i);
  if (m) return Number(m[1]);
  return null;
}

/**
 * Next links visible in an accessibility-snapshot text. A live Next is a
 * `link` element whose label reads "Next" (optionally "Next page" / with a
 * trailing arrow). On a numbered pager's last page Next is downgraded to
 * plain text — it stops being a link, and this returns nothing (FYR-303's
 * generic end-marker). Returns [{ref, label}].
 */
export function nextLinksFromSnapshot(snapshotText) {
  const out = [];
  for (const m of String(snapshotText ?? "").matchAll(/- link "([^"]*)"\s+\[ref=(e\d+)\]/g)) {
    const label = m[1];
    if (/^\s*next\b/i.test(label)) out.push({ ref: m[2], label });
  }
  return out;
}

/**
 * Scan the run's trace for pagination cues (harness-side — the extractor's
 * self-report is a forgeable marker and never consulted).
 *
 * Trace contract (browse-core records it): entries of
 *   { tool: "browser_snapshot", text }            — snapshot result text
 *   { tool: "browser_click", target, element, ok }
 *
 * Returns {
 *   pagerParses:   [{k, n, i}],        // every pager parse, in trace order
 *   followedNext:  [{ref, label, i}],  // Next links the loop actually clicked (ok: true)
 *   lastSnapshot:  string|null,        // the terminal (freshest) snapshot text
 *   lastSnapshotIndex: number|null,
 * }
 */
export function scanCues(trace) {
  const pagerParses = [];
  const followedNext = [];
  let lastSnapshot = null;
  let lastSnapshotIndex = null;

  (trace ?? []).forEach((entry, i) => {
    if (entry.tool === "browser_snapshot" && typeof entry.text === "string") {
      lastSnapshot = entry.text;
      lastSnapshotIndex = i;
      for (const { k, n } of parsePagerProgress(entry.text)) pagerParses.push({ k, n, i });
    }
    if (entry.tool === "browser_click" && entry.ok === true) {
      // The click's preceding snapshot must show a Next link carrying the
      // clicked ref (or, when no ref was captured, a Next label matching the
      // element description). Present-but-unfollowed Next is NOT a cue.
      const prevSnapshot = lastTraceSnapshotBefore(trace, i);
      if (prevSnapshot) {
        const links = nextLinksFromSnapshot(prevSnapshot);
        const hit =
          links.find((l) => l.ref === entry.target) ??
          (entry.element && /^next\b/i.test(entry.element)
            ? links.find((l) => l.label.toLowerCase().startsWith(entry.element.toLowerCase().trim()))
            : undefined);
        if (hit) followedNext.push({ ref: hit.ref, label: hit.label, i });
      }
    }
  });

  return { pagerParses, followedNext, lastSnapshot, lastSnapshotIndex };
}

function lastTraceSnapshotBefore(trace, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (trace[i]?.tool === "browser_snapshot" && typeof trace[i].text === "string") return trace[i].text;
  }
  return null;
}

/**
 * The hard gate (FYR-265). Eligible runs only: a run is gate-eligible iff the
 * trace holds a pager parse OR a followed Next; an unclassified run stays
 * telemetry-only and the gate never fires on it.
 *
 * Fires (union) iff eligible AND
 *   - a live Next ref survives on the terminal snapshot, OR
 *   - the freshest pager parse has k < n.
 * Contradictory cues fire. Unparseable terminal evidence fails open.
 *
 * @returns {{fired: boolean, pagination: object|null}} — pagination is the
 *   REQUIRED-iff-fired contract block {class_evidence, terminal_evidence}.
 */
export function paginationGate(cues) {
  const eligible = cues.pagerParses.length > 0 || cues.followedNext.length > 0;
  const liveNext = cues.lastSnapshot ? nextLinksFromSnapshot(cues.lastSnapshot) : [];
  const freshest = cues.pagerParses.length > 0 ? cues.pagerParses[cues.pagerParses.length - 1] : null;
  // Fail-open: with no terminal snapshot at all there is no parseable
  // terminal evidence either way — do not fire, log the diagnostic.
  const terminalParseable = cues.lastSnapshot !== null;
  const fire = eligible && terminalParseable && (liveNext.length > 0 || (freshest !== null && freshest.k < freshest.n));

  const pagination = {
    class_evidence: {
      pager_parse: freshest ? { k: freshest.k, n: freshest.n } : null,
      followed_next: cues.followedNext.map(({ ref, label }) => ({ ref, label })),
    },
    terminal_evidence: {
      live_next: liveNext.map(({ ref, label }) => ({ ref, label })),
      pager_parse: freshest ? { k: freshest.k, n: freshest.n } : null,
      parseable: terminalParseable,
    },
  };
  return { fired: fire, pagination };
}

// --- Coverage telemetry + the 0.9 check (FYR-265 fix) ------------------------

/**
 * Harness row count: the payload's primary array length (the payload itself
 * when it is an array, else the first array-typed property). Null when the
 * payload has no array shape — the check then has no numerator and no
 * arithmetic runs.
 */
export function rowsExtracted(data) {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") {
    for (const v of Object.values(data)) if (Array.isArray(v)) return v.length;
  }
  return null;
}

/**
 * The 0.9 check: rows < stated_total_parsed * 0.9 → coverage_suspect
 * (pass_with_warning). Reads the harness-parsed total ONLY; absent total or
 * absent rows → no arithmetic. Runs on pass-path structural outcomes (a
 * not_pass run is already a failure; the soft signal never upgrades it).
 */
export function coverageSuspect({ outcome_class, rows, statedTotalParsed }) {
  if (outcome_class === "not_pass") return false;
  if (rows === null || rows === undefined || statedTotalParsed === null || statedTotalParsed === undefined) return false;
  return rows < statedTotalParsed * 0.9;
}

// --- Identity judge contract (FYR-259) ----------------------------------------

/**
 * The judge runs only on pass-path structural outcomes; its input is the
 * snapshot + URL, never the payload. `judge` is an async fn
 * ({question, url, snapshotText}) → {pass, reason?, confidence?} | throws.
 * Returns {ran, pass?, reason?, confidence?, error?} per the payload contract:
 * a judge error sets ran:false + error and NEVER overrides the structural
 * verdict; pass:false → the caller overrides to semantic_rejected.
 */
export async function runIdentityJudge({ question, url, snapshotText, judge }) {
  try {
    const res = await judge({ question, url, snapshotText: snapshotText ?? "" });
    const out = { question, ran: true, pass: Boolean(res?.pass) };
    if (res?.pass) {
      // reason required iff ran && !pass — omitted on pass
    } else {
      out.reason = typeof res?.reason === "string" && res.reason ? res.reason : "the judge rejected the page without a reason";
    }
    if (res?.confidence !== undefined) out.confidence = res.confidence; // # not for routing
    return out;
  } catch (err) {
    return { question, ran: false, error: String(err?.message ?? err) };
  }
}

// --- Override precedence + envelope validation --------------------------------

/**
 * Apply FYR-265's override precedence:
 *   coverage_incomplete > semantic_rejected > coverage_suspect > structural.
 * Returns {outcome, outcome_class, pagination, semantic}. `semantic` is
 * present iff the judge ran (base-rate); `pagination` REQUIRED iff
 * coverage_incomplete fired.
 */
export function applyOverrides({ structuralOutcome, structuralClass, judge, pagination, suspect = false }) {
  if (pagination.fired) {
    return { outcome: "coverage_incomplete", outcome_class: "not_pass", pagination: pagination.pagination, semantic: judge ?? null };
  }
  if (judge && judge.ran && judge.pass === false) {
    return { outcome: "semantic_rejected", outcome_class: "not_pass", pagination: null, semantic: judge };
  }
  if (suspect) {
    return { outcome: "coverage_suspect", outcome_class: "pass_with_warning", pagination: null, semantic: judge ?? null };
  }
  return { outcome: structuralOutcome, outcome_class: structuralClass, pagination: null, semantic: judge ?? null };
}

const TWELVE_OUTCOMES = Object.freeze([
  "verified",
  "empty_confirmed",
  "asserted",
  "coverage_suspect",
  "coverage_incomplete",
  "empty_unconfirmed",
  "empty_schema_conflict",
  "schema_failed",
  "semantic_rejected",
  "no_terminal_call",
  "tool_error",
  "malformed_submit",
]);

const CLASS_OF = {
  verified: "pass",
  empty_confirmed: "pass",
  asserted: "pass_with_warning",
  coverage_suspect: "pass_with_warning",
  coverage_incomplete: "not_pass",
  empty_unconfirmed: "not_pass",
  empty_schema_conflict: "not_pass",
  schema_failed: "not_pass",
  semantic_rejected: "not_pass",
  no_terminal_call: "not_pass",
  tool_error: "not_pass",
  malformed_submit: "not_pass",
};

/** The outcome→class table, exported so consumers never re-derive it. */
export const OUTCOME_CLASS = CLASS_OF;

/**
 * Normative presence validation (FYR-259: "validator-enforced — not
 * comments"). The oracle never ships an envelope that violates its own
 * contract. Returns [] when valid, otherwise violation strings.
 */
export function validateEnvelope(env) {
  const bad = [];
  const has = (v) => v !== undefined && v !== null;
  const structural = env.structural_outcome;

  if (env.contract_version !== 2) bad.push(`contract_version must be 2, got ${JSON.stringify(env.contract_version)}`);
  if (!TWELVE_OUTCOMES.includes(env.outcome)) bad.push(`unknown outcome "${env.outcome}" (must be one of the twelve)`);
  if (!TWELVE_OUTCOMES.includes(structural)) bad.push(`unknown structural_outcome "${structural}"`);
  if (CLASS_OF[env.outcome] !== env.outcome_class) bad.push(`outcome_class ${JSON.stringify(env.outcome_class)} does not match outcome ${env.outcome}`);
  const OVERRIDES = new Set(["semantic_rejected", "coverage_suspect", "coverage_incomplete"]);
  if (env.outcome !== structural && !OVERRIDES.has(env.outcome)) {
    bad.push(`structural_outcome (${structural}) must equal outcome (${env.outcome}) unless an override fired`);
  }

  if (has(env.schema) && !["schema_failed", "empty_schema_conflict"].includes(structural)) {
    bad.push(`schema block present but structural_outcome is ${structural} (allowed: schema_failed, empty_schema_conflict)`);
  }
  if (["schema_failed", "empty_schema_conflict"].includes(structural) && !has(env.schema)) {
    bad.push(`schema block REQUIRED for structural_outcome ${structural}`);
  }
  if (has(env.empty) && !["empty_confirmed", "empty_unconfirmed", "empty_schema_conflict"].includes(structural)) {
    bad.push(`empty block present but structural_outcome is ${structural} (allowed: empty_confirmed, empty_unconfirmed, empty_schema_conflict)`);
  }
  if (["empty_confirmed", "empty_unconfirmed", "empty_schema_conflict"].includes(structural) && !has(env.empty)) {
    bad.push(`empty block REQUIRED for structural_outcome ${structural}`);
  }
  if (has(env.semantic) && env.semantic.ran === false && env.outcome === "semantic_rejected") {
    bad.push("semantic_rejected requires the judge to have run (a judge error never overrides a structural verdict)");
  }
  if (env.outcome === "semantic_rejected" && !(has(env.semantic) && env.semantic.ran === true && env.semantic.pass === false)) {
    bad.push("semantic block REQUIRED (ran: true, pass: false) for semantic_rejected");
  }
  if (env.outcome === "coverage_incomplete" && !has(env.pagination)) {
    bad.push("pagination block REQUIRED for coverage_incomplete");
  }
  if (has(env.pagination) && env.outcome !== "coverage_incomplete") {
    bad.push(`pagination block present but outcome is ${env.outcome} (required-iff coverage_incomplete)`);
  }
  if (["tool_error", "malformed_submit", "no_terminal_call"].includes(env.outcome) && !has(env.error)) {
    bad.push(`error block REQUIRED for ${env.outcome}`);
  }
  if (!has(env.coverage)) bad.push("coverage block ALWAYS present");
  if (typeof env.notes !== "string") bad.push("notes always present (string, may be empty)");

  // semantic field presence rules
  if (has(env.semantic)) {
    const s = env.semantic;
    if (s.ran === true) {
      if (typeof s.pass !== "boolean") bad.push("semantic.ran true requires a boolean semantic.pass");
      if (s.pass === false && !s.reason) bad.push("semantic.reason required when the judge ran and rejected");
    } else if (s.ran === false && !s.error) {
      bad.push("semantic.error required when the judge errored");
    }
  }

  // coverage field names: the _reported suffix is the guard (FYR-265)
  if (has(env.coverage)) {
    for (const key of ["last_page_reached_reported", "stated_total_reported", "stated_total_parsed"]) {
      if (!(key in env.coverage)) bad.push(`coverage.${key} always present (nullable)`);
    }
    if ("stated_total" in env.coverage || "last_page_reached" in env.coverage) {
      bad.push("coverage must not carry unsuffixed model-authored fields (use the _reported twins)");
    }
  }

  return bad;
}