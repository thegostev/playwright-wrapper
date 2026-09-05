# Per-machine setup

How to get `playwright-wrapper` working on a new machine. Do these steps once per machine. About ten minutes, most of it waiting for the Chromium download.

Mirrored in Linear as [Per-machine setup](https://linear.app/lage/document/per-machine-setup-b7ce6b0107ae) - edit this copy and paste it there.

- Repo: https://github.com/thegostev/playwright-wrapper-by-gostev
- Design map: [LAG-247](https://linear.app/lage/issue/LAG-247/llmplaywright-test-automation-wrapper-wayfinder-map)

## What you get

Five commands on your PATH - `plan`, `generate`, `heal`, `browse`, `skill` - and a Claude Code skill that lets a session reach for the first four without you naming the tool.

## Before you start

- Node 20 or newer. Check with `node -v`.
- An Ollama Cloud API key from https://ollama.com.
- Optional: an OpenAI key. Its presence alone turns on one stronger last-resort attempt when healing is stuck. Without it, heal stops at the ladder and hands you what it tried.

## 1. Put the keys in a secrets file

The wrapper reads all LLM config from the environment. It never takes a key as a flag, never logs one, never writes one to disk.

```sh
mkdir -p ~/.secrets
cat > ~/.secrets/playwright-wrapper.env <<'EOF'
export WRAPPER_OLLAMA_API_KEY=...
# optional - presence alone enables the third-tier heal attempt
# export OPENAI_API_KEY=...
EOF
chmod 600 ~/.secrets/playwright-wrapper.env
```

Source it from your shell profile:

```sh
echo '[ -f ~/.secrets/playwright-wrapper.env ] && . ~/.secrets/playwright-wrapper.env' >> ~/.zshrc
```

This follows the workspace rule: keys live in `~/.secrets/*.env` at 0600. Never in a repo, never in a vault, never in a `CLAUDE.md`.

## 2. Install the wrapper

The package name is `playwright-wrapper-by-gostev`. The bare npm name `playwright-wrapper` belongs to someone else - do **not** run `npm i -g playwright-wrapper`, it installs a stranger's package under our bin name.

Nothing is published yet, so use the source path:

```sh
git clone https://github.com/thegostev/playwright-wrapper-by-gostev.git ~/Developer/playwright-wrapper
cd ~/Developer/playwright-wrapper
npm install
npm link
```

After publishing this becomes one line - `npm i -g playwright-wrapper-by-gostev`. The bin stays `playwright-wrapper` either way.

## 3. Install Chromium

```sh
npx playwright install chromium
```

The first `plan`, `heal` or `browse` on a cold `chromium-headless-shell` takes two to three minutes. Later runs are fast. Do not read the first slow run as a hang.

## 4. Install the Claude Code skill

```sh
playwright-wrapper skill install
```

That writes `~/.claude/skills/playwright-wrapper/SKILL.md` and stamps it with the package version. It is per machine and lives outside the vaults, so the `.agents/sync-*.sh` scripts do not cover it - those copy into vault `.claude/`, and this skill must be global.

Re-run it after every package upgrade. Three things can happen:

- **nothing installed yet** - it writes the file and names the path.
- **installed copy is unedited** - it replaces the file and names both versions, so a skill lagging its bin is visible rather than silent.
- **installed copy has local edits** - it refuses, naming the installed version and the package version. `--force` replaces it anyway; `--print` writes the stamped skill to stdout so you can diff it yourself.

Local edits belong in `skill/SKILL.md` in the repo, which is the canonical source. Editing the installed copy means losing the edit at the next `--force`.

## 5. Check it worked

```sh
playwright-wrapper --help
```

Exit codes: `0` ok, `1` config error or a not-pass result, `2` usage error. A missing or empty `WRAPPER_OLLAMA_API_KEY` fails at startup and names the variable, never the value.

A live end-to-end check that touches the model, the browser and the oracle:

```sh
cat > /tmp/careers.md <<'EOF'
profile: browsing
target: https://jobs.fortum.com/search/

List every open role with title, location, and link.
EOF
playwright-wrapper browse /tmp/careers.md
```

And a check that the skill is live: start a fresh Claude Code session and ask for an E2E test for some page without naming the wrapper. The skill should fire on its own.

## Optional overrides

Only `WRAPPER_OLLAMA_API_KEY` is required. The rest have working defaults.

| Variable | What it does | Default |
| -- | -- | -- |
| `WRAPPER_OLLAMA_API_KEY` | Ollama Cloud key. Required. | - |
| `WRAPPER_OLLAMA_BASE_URL` | OpenAI-compatible endpoint | `https://ollama.com/v1` |
| `WRAPPER_MODEL_MAIN` | Main model id | `glm-5.3-flash` |
| `WRAPPER_MODEL_FALLBACK` | Second model, used only after a failure | `glm-5.3` |
| `OPENAI_API_KEY` | Presence enables the third-tier heal attempt | - |
| `WRAPPER_OPENAI_BASE_URL` | Third-tier endpoint | `https://api.openai.com/v1` |
| `WRAPPER_OPENAI_MODEL` | Third-tier model id | `gpt-5.6-sol` |

Model ids are bare on the hosted endpoint. A `:cloud` suffix returns 404 there.

## Per consumer repo, not per machine

Any repo that will hold generated tests sets four things in its `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './playwright-output/<project>/specs',
  use: { baseURL: process.env.BASE_URL },
  captureGitInfo: true,
  reporter: process.env.CI ? [['json', { outputFile: 'results.json' }]] : 'list',
});
```

`baseURL` from env is what makes a generated test portable. `captureGitInfo` stamps the commit into the report, and that is what lets heal refuse to patch against an app that has moved.

Gitignore the run folders - `playwright-output/*/<run-id>/` - and never the `playwright-output/` root. A blanket ignore on the root disables the CI stamp lint silently.

## Known state, 2026-09-05

- Nothing is published to npm. `playwright-wrapper-by-gostev` and `@thegostev/playwright-wrapper-by-gostev` were both free on the registry when checked; the unscoped name is the one this package claims.
- The clone at `Utvikling - Obsidian/1 - Code/Playwright/playwright-wrapper` is stale: branch `alex/fyr-258-...`, four commits, two modified spike files. Treat `~/Developer/playwright-wrapper` as the working clone, or reset the vault one onto main.
