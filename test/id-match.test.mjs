// Regen identity matching (FYR-267) — the ten unit cases.
// Run with `npm test` (`node --test`).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { matchIds } from '../src/id-match.mjs';

const old = (pairs) => pairs.map(([id, action, locator]) => ({ id, action, locator }));
const fresh = (actions) => actions.map((action) => ({ action }));

const planA = old([
  ['s1', 'go to the login page'],
  ['s2', 'fill the email field'],
  ['s3', 'fill the password field'],
  ['s4', 'submit the form'],
  ['s5', 'assert the dashboard heading is shown'],
]);
const actionsOfPlanA = planA.map((s) => s.action);

describe('matchIds — regen identity', () => {
  it('1. unchanged plan: every id stable, mark unmoved, nothing dead', () => {
    const r = matchIds({ oldSteps: planA, newSteps: fresh(actionsOfPlanA), nextId: 's6' });
    assert.equal(r.ok, true, r.problems?.join(' | '));
    assert.deepEqual(r.assignments.map((a) => a.id), ['s1', 's2', 's3', 's4', 's5']);
    assert.ok(r.assignments.every((a) => a.source === 'kept'));
    assert.equal(r.nextId, 's6');
    assert.deepEqual(r.deadIds, []);
  });

  it('2. inserted step: takes the next id from the mark, nothing renumbers', () => {
    const actions = [...actionsOfPlanA];
    actions.splice(2, 0, 'tick the remember-me checkbox');
    const r = matchIds({ oldSteps: planA, newSteps: fresh(actions), nextId: 's6' });
    assert.equal(r.ok, true, r.problems?.join(' | '));
    assert.deepEqual(r.assignments.map((a) => a.id), ['s1', 's2', 's6', 's3', 's4', 's5']);
    assert.equal(r.assignments[2].source, 'fresh');
    assert.equal(r.nextId, 's7');
  });

  it('3. deleted step: the id is dead and never reissued', () => {
    const actions = actionsOfPlanA.filter((a) => a !== 'fill the password field');
    const r = matchIds({ oldSteps: planA, newSteps: fresh(actions), nextId: 's6' });
    assert.equal(r.ok, true, r.problems?.join(' | '));
    assert.deepEqual(r.assignments.map((a) => a.id), ['s1', 's2', 's4', 's5']);
    assert.deepEqual(r.deadIds, ['s3']);
    // And the dead id stays dead on the *next* regen too: s3 is below the
    // mark and no action claims it.
    const r2 = matchIds({ oldSteps: r.assignments, newSteps: fresh([...actions, 'a brand new step']), nextId: r.nextId });
    assert.equal(r2.ok, true, r2.problems?.join(' | '));
    assert.ok(!r2.assignments.some((a) => a.id === 's3'), 'dead id s3 must never be reissued');
    assert.equal(r2.assignments.at(-1).id, 's6');
  });

  it('4. reworded action: new id from the mark, history visibly lost', () => {
    const actions = actionsOfPlanA.map((a) => (a === 'submit the form' ? 'click the sign in button' : a));
    const r = matchIds({ oldSteps: planA, newSteps: fresh(actions), nextId: 's6' });
    assert.equal(r.ok, true, r.problems?.join(' | '));
    assert.equal(r.assignments[3].id, 's6');
    assert.equal(r.assignments[3].source, 'fresh');
    assert.deepEqual(r.deadIds, ['s4']); // the old step's id is history now
  });

  it('5. locator-only change: id stable', () => {
    const newSteps = planA.map((s) =>
      s.id === 's2' ? { action: s.action, locator: "getByLabel('Email address')" } : { action: s.action },
    );
    const r = matchIds({ oldSteps: planA, newSteps, nextId: 's6' });
    assert.equal(r.ok, true, r.problems?.join(' | '));
    assert.deepEqual(r.assignments.map((a) => a.id), ['s1', 's2', 's3', 's4', 's5']);
  });

  it('6. human token override across a reword: id preserved', () => {
    const actions = actionsOfPlanA.map((a) => (a === 'submit the form' ? 'click the sign in button' : a));
    const r = matchIds({
      oldSteps: planA, newSteps: fresh(actions), nextId: 's6',
      overrides: { 3: { keep: 's4' } },
    });
    assert.equal(r.ok, true, r.problems?.join(' | '));
    assert.equal(r.assignments[3].id, 's4');
    assert.equal(r.assignments[3].source, 'override-keep');
    assert.deepEqual(r.deadIds, []);
  });

  it('6b. clearing a token forces a fresh id on unchanged text', () => {
    const r = matchIds({
      oldSteps: planA, newSteps: fresh(actionsOfPlanA), nextId: 's6',
      overrides: { 4: { clear: true } },
    });
    assert.equal(r.ok, true, r.problems?.join(' | '));
    assert.equal(r.assignments[4].id, 's6');
    assert.deepEqual(r.deadIds, ['s5']);
  });

  it('7. duplicate kept token: rejected', () => {
    const r = matchIds({
      oldSteps: planA,
      newSteps: fresh(['new step one', 'new step two']),
      nextId: 's6',
      overrides: { 0: { keep: 's2' }, 1: { keep: 's2' } },
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.join(' | ').includes('s2'), r.problems);
  });

  it("8. override steals a surviving step's natural id: rejected until resolved", () => {
    const r = matchIds({
      oldSteps: planA,
      newSteps: fresh(['sign the user in', 'submit the form']),
      nextId: 's6',
      overrides: { 0: { keep: 's4' } },
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('s4') && p.includes('clear')), r.problems);
  });

  it('9. kept token that never existed: rejected', () => {
    const r = matchIds({
      oldSteps: planA, newSteps: fresh(['a reworded step']), nextId: 's6',
      overrides: { 0: { keep: 's9' } },
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('never existed')), r.problems);
  });

  it('10. duplicate action text in the new plan: rejected', () => {
    const r = matchIds({
      oldSteps: planA,
      newSteps: fresh(['click Next', 'click Next']),
      nextId: 's6',
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('duplicate action')), r.problems);
  });

  it('10b. duplicate action text in the old plan: rejected', () => {
    const r = matchIds({
      oldSteps: old([['s1', 'click Next'], ['s2', 'click Next']]),
      newSteps: fresh(['click Next']),
      nextId: 's3',
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('duplicate action')), r.problems);
  });

  it('old plan above its own mark: rejected (inconsistent high-water mark)', () => {
    const r = matchIds({
      oldSteps: old([['s1', 'a'], ['s6', 'b']]),
      newSteps: fresh(['a']),
      nextId: 's6',
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('high-water mark')), r.problems);
  });

  it('override naming a nonexistent new-step index: rejected', () => {
    const r = matchIds({
      oldSteps: planA, newSteps: fresh(actionsOfPlanA), nextId: 's6',
      overrides: { 7: { keep: 's2' } },
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('does not name a step')), r.problems);
  });

  it('keep and clear together: rejected', () => {
    const r = matchIds({
      oldSteps: planA, newSteps: fresh(actionsOfPlanA), nextId: 's6',
      overrides: { 0: { keep: 's1', clear: true } },
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('mutually exclusive')), r.problems);
  });
});
