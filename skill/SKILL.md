---
name: playwright-wrapper
description: Write a Playwright E2E test from a plain-English description, fix a spec that broke in CI, extract structured JSON from a public page, or read a page this session cannot otherwise fetch. Not for executing an existing suite - that is npx playwright test.
---

# playwright-wrapper

An LLM in front of Playwright, running as its own process with its own model.
Call the bin, read stdout, act on the exit code. Drive nothing yourself.

`WRAPPER_OLLAMA_API_KEY` must be set in the environment. If the bin exits 1
naming it, tell the user to set it in their shell and stop. Never pass a key
on the command line.

## Pick the verb

| What the user wants | Verb |
| --- | --- |
| an E2E test from a plain-English description | `plan`, then `generate` |
| a spec that broke in CI fixed | `heal` |
| structured data off a public page | `browse` |
| to read a page you cannot fetch | `browse` |

Executing an existing suite is `npx playwright test`. No verb here.

## Write the task spec first

Every verb but `generate` takes a spec file: a keyed header, a blank line, then
the goal in the user's own words. Write it to `/tmp/<name>.md` unless the user
names a path, then pass that path.

```
profile: test
target: https://app.example.com/login

Sign in with a valid account and land on the dashboard.
```

The browsing profile takes an optional `browse:` block, where `schema` points
at a JSON Schema file the extraction is checked against:

```
profile: browsing
target: https://example.com/careers
browse:
  schema: /tmp/roles.schema.json
  allowEmpty: false
  identityQuestion: is this the careers listing page?

List every open role with title, location, and link.
```

`profile` is declared by the human. Ask which one when the request is ambiguous.

## The plan gate

`plan` and `generate` are two turns with the user in between.

Turn 1: run `playwright-wrapper plan /tmp/<name>.md > /tmp/<name>.plan.md`,
show the plan to the user, ask them to approve or edit it, end your turn.

Turn 2: only after the user has answered, run
`playwright-wrapper generate < /tmp/<name>.plan.md`.

Never run `generate` in the same turn as `plan`. Never approve a plan on the
user's behalf.

## Heal

```
playwright-wrapper heal <run-folder>
```

The run folder holds `results.json`; its name carries the report's commit SHA.
Heal refuses when that SHA differs from the checkout - report the refusal
rather than working around it.

## Browse

```
playwright-wrapper browse /tmp/<name>.md
```

Prints an outcome envelope on stdout: the extracted rows plus how they were
judged. Hand a not-pass to the user with the envelope's reason, unreworded.

## Where the artifacts land

- `generate` writes `<testDir>/<file>.spec.ts` and `<testDir>/<file>.plan.md`
  into the consumer repo. `testDir` comes from the consumer's
  `playwright.config.ts` (default `./tests`). It refuses on a dirty or
  untracked tree - ask the user to commit or stash, never stash for them.
- `heal` writes a `.heal.md` record beside `results.json` in the run folder.
- `browse` persists its trace under
  `playwright-output/<project>/browse/<run-id>/trace.json`.

## Exit codes

`0` ok. `1` config error or a not-pass result. `2` usage error. A non-zero exit
is an answer - report what the bin said.

Deeper: `playwright-wrapper <verb> --help` for one verb's full contract, and
https://github.com/thegostev/playwright-wrapper-by-gostev for everything else.
