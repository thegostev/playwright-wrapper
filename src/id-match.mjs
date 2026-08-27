// Regen identity matching (FYR-267).
//
// Ids are harness-assigned, never model-assigned: model output is not
// deterministic, and two runs of the same plan through a model would produce
// different ids — while the healer and the .heal.md history must keep
// pointing at the same step across runs. On regeneration the harness matches
// the old plan's steps to the new plan's steps and writes the tokens itself.
//
// The match rule is mechanical, not semantic: exact action-text equality.
//   same action text        -> keep the id (a locator-only edit keeps the id
//                              and its heal history — that is the point)
//   changed or new text     -> take the next id from the high-water mark
//   deleted step            -> its id is dead and never reissued
// A reworded step loses its history. That is correct and honest: the loss is
// visible in the plan diff the human already reviews under FYR-268.
//
// The gate can override the rule (FYR-267 Q11): the human may keep a token
// across a reword, or clear one to force a fresh id. Overrides are validated
// — no duplicate tokens, no token at or above next_id, no token that never
// existed. Nothing is repaired; invalid input is a list of loud problems.

const ID_RE = /^s(\d+)$/;

// oldSteps: [{id, action, ...}] from the previously approved plan.
// newSteps: [{action, ...}] from the current (gate-edited) plan; their tokens
//           have not been written yet — that is what this function returns.
// nextId:   the header's high-water mark, e.g. 's7'.
// overrides: human gate edits keyed by new-step index:
//           {0: {keep: 's3'}}  keep id s3 for new step 0 (across a reword)
//           {2: {clear: true}} force a fresh id for new step 2
//
// Returns {ok:true, assignments, nextId, deadIds} where assignments is
// [{index, action, id, source:'kept'|'fresh'|'override-keep'}] in new-plan
// order, or {ok:false, problems[]}.
export function matchIds({ oldSteps, newSteps, nextId, overrides = {} }) {
  const problems = [];
  const next = nextId?.match(ID_RE);
  if (!next) {
    return { ok: false, problems: [`next_id must be s<N> (got: ${nextId})`] };
  }
  let alloc = Number(next[1]);

  // Duplicate action text is rejected at generate; check here too so the
  // matcher is never asked to guess between twins.
  for (const [name, steps] of [['old', oldSteps], ['new', newSteps]]) {
    const seen = new Set();
    for (const s of steps) {
      if (seen.has(s.action)) {
        problems.push(`${name} plan has duplicate action "${s.action}" — regen matching cannot disambiguate; make the actions textually distinct`);
      }
      seen.add(s.action);
    }
  }

  const oldIds = new Map(); // id -> action
  for (const s of oldSteps) {
    const m = s.id?.match(ID_RE);
    if (!m) {
      problems.push(`old step id ${s.id} is not of the form s<N>`);
      continue;
    }
    if (oldIds.has(s.id)) {
      problems.push(`old plan has duplicate id ${s.id}`);
      continue;
    }
    if (Number(m[1]) >= alloc) {
      problems.push(`old step id ${s.id} is at or above next_id ${nextId} — the plan's high-water mark is inconsistent`);
    }
    oldIds.set(s.id, s.action);
  }
  const oldIdByAction = new Map();
  for (const s of oldSteps) if (!oldIdByAction.has(s.action)) oldIdByAction.set(s.action, s.id);

  // Override validation up front, so a bad gate edit blocks the whole
  // assignment rather than producing a half-consistent one.
  for (const [rawIndex, ov] of Object.entries(overrides)) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= newSteps.length) {
      problems.push(`override index ${rawIndex} does not name a step in the new plan`);
      continue;
    }
    if (ov.keep !== undefined) {
      if (!ID_RE.test(ov.keep)) {
        problems.push(`override on new step ${index}: kept token ${ov.keep} is not of the form s<N>`);
      } else if (!oldIds.has(ov.keep)) {
        problems.push(`override on new step ${index}: ${ov.keep} never existed — the gate may keep an issued id or clear one, never mint a new token`);
      }
    }
    if (ov.keep !== undefined && ov.clear) {
      problems.push(`override on new step ${index}: keep and clear are mutually exclusive`);
    }
  }
  if (problems.length) return { ok: false, problems };

  const assignments = [];
  const assignedIds = new Set();
  for (let i = 0; i < newSteps.length; i++) {
    const step = newSteps[i];
    const ov = overrides[i];
    if (ov?.keep !== undefined) {
      const id = ov.keep;
      if (assignedIds.has(id)) {
        problems.push(`override on new step ${i}: ${id} is already assigned in this regeneration — one token, one step`);
        continue;
      }
      // A keep that steals the id a surviving step would naturally inherit:
      // the natural claimant comes later in new-plan order, so detect by
      // looking ahead.
      const naturalClaimant = newSteps.findIndex(
        (s, j) => j !== i && s.action === oldIds.get(id),
      );
      if (naturalClaimant !== -1 && overrides[naturalClaimant]?.keep !== id && !overrides[naturalClaimant]?.clear) {
        problems.push(`override on new step ${i}: ${id} is the natural id of new step ${naturalClaimant} (action "${oldIds.get(id)}") — clear that step's token first if the move is intended`);
        continue;
      }
      assignedIds.add(id);
      assignments.push({ index: i, action: step.action, id, source: 'override-keep' });
      continue;
    }
    if (ov?.clear) {
      const id = `s${alloc++}`;
      assignedIds.add(id);
      assignments.push({ index: i, action: step.action, id, source: 'override-fresh' });
      continue;
    }
    const inherited = oldIdByAction.get(step.action);
    if (inherited && !assignedIds.has(inherited)) {
      assignedIds.add(inherited);
      assignments.push({ index: i, action: step.action, id: inherited, source: 'kept' });
      continue;
    }
    if (inherited && assignedIds.has(inherited)) {
      problems.push(`new step ${i} (action "${step.action}") would keep ${inherited}, but that id was already taken by an override — resolve at the gate`);
      continue;
    }
    const id = `s${alloc++}`;
    assignedIds.add(id);
    assignments.push({ index: i, action: step.action, id, source: 'fresh' });
  }
  if (problems.length) return { ok: false, problems };

  const deadIds = [...oldIds.keys()].filter((id) => !assignedIds.has(id));
  return { ok: true, assignments, nextId: `s${alloc}`, deadIds };
}
