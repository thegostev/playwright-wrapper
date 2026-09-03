// Plan parsing, validation, and spec lint (FYR-267) — acceptance + refusals.
// Run with `npm test` (`node --test`).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePlan,
  PlanParseError,
  validatePlan,
  checkPlan,
  lintLocator,
  lintSpec,
} from '../src/plan-parse.mjs';

const GOOD_PLAN = `profile: test
title: user can sign in
file: user-can-sign-in
next_id: s7
---
## steps

- id: s1
  action: go to the login page
  locator: none
  value: literal '/login'
- id: s2
  action: fill the email field
  locator: getByLabel('Email')
  value: env:E2E_USER
  reason: label present on the form
- id: s3
  action: fill the password field
  locator: getByLabel('Password')
  value: env:E2E_PASSWORD
  reason: label present on the form
- id: s4
  action: submit the form
  locator: getByRole('button', { name: 'Sign in' })
  reason: role=button, name="Sign in"
- id: s5
  action: assert the dashboard heading is shown
  locator: getByRole('heading', { name: 'Dashboard' })
  expect: visible
  reason: role=heading
`;

// Swap one field in the good plan's text without re-deriving the fixture.
function variant(replacements) {
  let text = GOOD_PLAN;
  for (const [from, to] of replacements) {
    if (!text.includes(from)) throw new Error(`fixture does not contain: ${from}`);
    text = text.replace(from, to);
  }
  return text;
}

describe('parsePlan — the keyed-line format', () => {
  it('parses the happy plan', () => {
    const plan = parsePlan(GOOD_PLAN);
    assert.equal(plan.header.profile, 'test');
    assert.equal(plan.header.title, 'user can sign in');
    assert.equal(plan.header.file, 'user-can-sign-in');
    assert.equal(plan.header.next_id, 's7');
    assert.equal(plan.steps.length, 5);
    assert.deepEqual(plan.steps[0], {
      id: 's1', action: 'go to the login page', locator: 'none',
      value: "literal '/login'", line: 8,
    });
    assert.equal(plan.steps[1].locator, "getByLabel('Email')");
    assert.equal(plan.steps[4].expect, 'visible');
  });

  it('checkPlan is ok on the happy plan and collects env names', () => {
    const r = checkPlan(GOOD_PLAN);
    assert.equal(r.ok, true);
    assert.deepEqual(r.envNames.sort(), ['E2E_PASSWORD', 'E2E_USER']);
  });

  const parseRefusals = [
    ['CR line endings', GOOD_PLAN.replaceAll('\n', '\r\n'), 'CR'],
    ['non-ASCII', variant([['go to the login page', 'go to the login pagé']]), 'non-ASCII'],
    ['trailing whitespace', variant([['title: user can sign in', 'title: user can sign in ']]), 'trailing whitespace'],
    ['unknown header key', variant([['title: user can sign in', 'title: user can sign in\nowner: qa']]), 'unknown header key'],
    ['duplicate header key', variant([['title: user can sign in', 'title: user can sign in\ntitle: user can sign in again']]), 'duplicate header key'],
    ['missing separator', GOOD_PLAN.replace('---\n', ''), 'separator'],
    ['missing ## steps', GOOD_PLAN.replace('## steps\n', '## plan\n'), '## steps'],
    ['unknown step key', variant([['  reason: label present on the form\n- id: s3', '  reason: label present on the form\n  note: handwritten\n- id: s3']]), 'unknown step key'],
    ['duplicate step key', variant([['  action: fill the email field', '  action: fill the email field\n  action: fill the email field twice']]), 'duplicate step key'],
    ['field before any step', GOOD_PLAN.replace('## steps\n\n- id: s1', '## steps\n\n  action: orphan'), 'before any'],
  ];
  for (const [name, text, fragment] of parseRefusals) {
    it(`refuses: ${name}`, () => {
      assert.throws(() => parsePlan(text), (err) => {
        assert.ok(err instanceof PlanParseError, `expected PlanParseError, got ${err}`);
        assert.match(err.message, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
        return true;
      });
    });
  }
});

describe('validatePlan — boundary validation before any model call', () => {
  it('accepts the happy plan', () => {
    assert.equal(validatePlan(parsePlan(GOOD_PLAN)).ok, true);
  });
  it('accepts dead ids below the mark (s6 absent, next_id s7)', () => {
    assert.equal(validatePlan(parsePlan(GOOD_PLAN)).ok, true);
  });

  const invalid = [
    ['duplicate id',
      [['- id: s3\n  action: fill the password field', '- id: s2\n  action: fill the password field']],
      'duplicate id s2'],
    ['id at or above next_id',
      [['- id: s5\n  action: assert', '- id: s7\n  action: assert']],
      'at or above next_id'],
    ['duplicate action text',
      [['  action: fill the password field', '  action: fill the email field']],
      'duplicate action'],
    ['profile must be test',
      [['profile: test', 'profile: browsing']],
      'profile must be'],
    ['file must be a slug',
      [['file: user-can-sign-in', 'file: User Can Sign_In']],
      'file'],
    ['next_id shape',
      [['next_id: s7', 'next_id: 7']],
      'next_id'],
    ['missing locator field',
      [['  locator: none\n  value: literal \'/login\'', '  value: literal \'/login\'']],
      'missing'],
    ['value and expect together',
      [['  expect: visible', "  value: literal 'x'\n  expect: visible"]],
      'both'],
    ['bad value form',
      [['  value: env:E2E_USER', '  value: process.env.E2E_USER']],
      'value must be'],
    ['bad env name',
      [['  value: env:E2E_USER', '  value: env:e2e_user']],
      'value must be'],
    ['page-level assertion with locator',
      [['  expect: visible', "  expect: url '/dashboard'"]],
      'page-level'],
    ['locator-bearing assertion, locator none',
      [['  locator: getByRole(\'heading\', { name: \'Dashboard\' })', '  locator: none']],
      'nothing to assert'],
    ['hidden without reason',
      [['  expect: visible', '  expect: hidden'], ['  reason: role=heading\n', '']],
      'hidden'],
  ];
  for (const [name, replacements, fragment] of invalid) {
    it(`refuses: ${name}`, () => {
      const r = checkPlan(variant(replacements));
      assert.equal(r.ok, false);
      assert.ok(
        r.problems.some((p) => p.includes(fragment)),
        `problems should mention ${JSON.stringify(fragment)}; got: ${r.problems.join(' | ')}`,
      );
    });
  }
});

describe('lintLocator — the Q12 slot grammar', () => {
  const accepts = [
    "getByRole('button', { name: 'Sign in' })",
    "getByRole('button', { name: 'Sign in', exact: true })",
    "getByRole('button')",
    "getByLabel('Email')",
    "getByTestId('submit')",
    "getByText('Dashboard')",
    "getByRole('list').getByRole('listitem').first()",
    "getByRole('list').getByRole('listitem').nth(12)",
    "getByRole('row').filter({ hasText: 'Pending' }).last()",
  ];
  for (const slot of accepts) {
    it(`accepts: ${slot}`, () => {
      assert.equal(lintLocator(slot).ok, true, lintLocator(slot).problem);
    });
  }

  const refuses = [
    ["page.locator('#submit')", 'page.locator() is banned'],
    ["page.goto.locator?.('x')", undefined],
    ['page.click', undefined],
    ["css=.btn", undefined],
    ["frameLocator('#f').getByRole('button')", 'frameLocator'],
    ["getByRole('button', { name: /sign/i })", 'not a whitelisted locator call'],
    ["getByText(`hello ${'${'}name}`)", 'template literals'],
    ["getByLabel(field)", 'not a whitelisted locator call'],
    ["getByRole('butto')", 'unknown ARIA role'],
    ["getByRole('button', { name: 'Sign' })  .first()", 'cannot parse'],
    ["getByText('a') + getByText('b')", 'cannot parse'],
  ];
  for (const [slot, fragment] of refuses) {
    it(`refuses: ${slot}`, () => {
      const r = lintLocator(slot);
      assert.equal(r.ok, false, slot);
      if (fragment) {
        assert.ok(r.problem.includes(fragment), `got: ${r.problem}`);
      }
    });
  }

  it('flags position selectors so validation can demand a reason', () => {
    assert.equal(lintLocator("getByRole('listitem').nth(2)").usesPosition, true);
    assert.equal(lintLocator("getByRole('listitem')").usesPosition, false);
  });
});

describe('lintSpec — the generated-spec lint', () => {
  const GOOD_SPEC = `// plan-sha256: deadbeef
import { test, expect } from '@playwright/test';

const E2E_USER = process.env.E2E_USER;
if (!E2E_USER) throw new Error('missing env var E2E_USER');

test('user can sign in', async ({ page }) => {
  await test.step('[s1] go to the login page', async () => {
    await page.goto('/login');
  });
  await test.step('[s2] fill the email field', async () => {
    await page.getByLabel('Email').fill(E2E_USER);
  });
  await test.step('[s3] submit the form', async () => {
    await page.getByRole('button', { name: 'Sign in' }).click();
  });
  await test.step('[s4] assert the dashboard heading is shown', async () => {
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});
`;

  function specVariant(from, to) {
    if (!GOOD_SPEC.includes(from)) throw new Error(`fixture does not contain: ${from}`);
    return GOOD_SPEC.replace(from, to);
  }

  it('accepts the good spec and extracts the ids', () => {
    const r = lintSpec(GOOD_SPEC);
    assert.equal(r.ok, true, r.problems?.join(' | '));
    assert.deepEqual(r.ids, ['s1', 's2', 's3', 's4']);
  });

  it('refuses a per-step timeout', () => {
    const r = lintSpec(GOOD_SPEC.replace('await page.goto(\'/login\');', "await page.click('x', { timeout: 5000 });"));
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('timeout')));
  });

  it('refuses expect.soft', () => {
    const r = lintSpec(specVariant('await expect(page', 'await expect.soft(page'));
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('expect.soft()')));
  });

  it('refuses storageState (login is ordinary plan steps)', () => {
    const r = lintSpec(GOOD_SPEC.replace('test(', "test.use({ storageState: 'auth.json' });\ntest("));
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('storageState')));
  });

  it('refuses an absolute goto URL', () => {
    const r = lintSpec(specVariant("page.goto('/login')", "page.goto('http://localhost:3000/login')"));
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('relative URL')));
  });

  it('refuses a duplicate step token', () => {
    const r = lintSpec(specVariant("[s3] submit the form", "[s2] submit the form"));
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('duplicate step token')));
  });

  it('refuses a step without an id token', () => {
    const r = lintSpec(specVariant("[s3] submit the form", "submit the form"));
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('id token')));
  });

  it('refuses a multi-line locator slot', () => {
    const src = specVariant(
      "await page.getByRole('button', { name: 'Sign in' }).click();",
      "await page.getByRole('button', { name:\n        'Sign in' }).click();",
    );
    const r = lintSpec(src);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('one line')));
  });

  it('refuses env use without the module-top throw-guard', () => {
    const r = lintSpec(specVariant('if (!E2E_USER) throw new Error', 'if (!(E2E_USER)) throw new Error'));
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('throw-guard')));
  });

  it('refuses an env fallback literal', () => {
    const r = lintSpec(specVariant('const E2E_USER = process.env.E2E_USER;', "const E2E_USER = process.env.E2E_USER ?? 'a@b.c';"));
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('fallback literal')));
  });
});
