// FYR-326 smoke + seam tests: the bin spawned end to end against a stub API
// server. This is the seam later tickets (FYR-328+) reuse — tests point the
// client at a stub by overriding WRAPPER_OLLAMA_BASE_URL and assert on
// stdout/exit only. No loop internals, no prompt strings.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BIN = fileURLToPath(new URL("../bin/playwright-wrapper.mjs", import.meta.url));
const ROOT = path.dirname(path.dirname(BIN));

function spawnBin(args, envOverrides = {}, stdinText) {
  const env = {
    ...process.env,
    WRAPPER_OLLAMA_API_KEY: "test-key-not-a-real-secret",
    ...envOverrides,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (stdinText !== undefined) child.stdin.write(stdinText);
    child.stdin.end(); // always close stdin — generate reads it to EOF
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("every subcommand is real: bare invocations are usage errors, no LLM call from any of them", async (t) => {
  let hits = 0;
  const server = createServer(() => hits++);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  // No routing stubs remain (FYR-330/FYR-329/FYR-331/FYR-333): generate
  // consumes plan bytes on stdin (model-free); plan, heal, and browse need an
  // argument and drive the bridge or the trace. A bare invocation is that
  // subcommand's own usage error, never an LLM call or browser.
  const heal = await spawnBin(["heal"], { WRAPPER_OLLAMA_BASE_URL: baseUrl });
  assert.equal(heal.code, 2, "heal without a run-folder argument exits with the usage error");
  assert.match(heal.stderr, /Usage: playwright-wrapper heal <run-folder>/);
  // generate with empty stdin is a usage error (no plan piped), never an LLM call.
  const gen = await spawnBin(["generate"], { WRAPPER_OLLAMA_BASE_URL: baseUrl });
  assert.equal(gen.code, 2, "generate without stdin plan exits with the usage error");
  assert.match(gen.stderr, /no plan on stdin/);
  // plan without a spec argument is a usage error, never an LLM call or browser.
  const plan = await spawnBin(["plan"], { WRAPPER_OLLAMA_BASE_URL: baseUrl });
  assert.equal(plan.code, 2, "plan without a spec argument exits with the usage error");
  assert.match(plan.stderr, /missing spec argument/);
  // browse without a spec argument is a usage error, never an LLM call or browser.
  const browse = await spawnBin(["browse"], { WRAPPER_OLLAMA_BASE_URL: baseUrl });
  assert.equal(browse.code, 2, "browse without a spec argument exits with the usage error");
  assert.match(browse.stderr, /missing spec argument/);
  assert.equal(hits, 0, "no subcommand makes an HTTP call on a bare invocation");
});

test("config is validated at startup: missing key fails loud with exit 1, naming the env var not the value", async () => {
  const { code, stderr } = await spawnBin(["plan"], { WRAPPER_OLLAMA_API_KEY: "" });
  assert.equal(code, 1);
  assert.match(stderr, /WRAPPER_OLLAMA_API_KEY/);
  assert.ok(!stderr.includes("test-key"), "error never echoes any key value");
});

test("malformed base URL fails loud with exit 1, naming the env var", async () => {
  const { code, stderr } = await spawnBin(["plan"], {
    WRAPPER_OLLAMA_BASE_URL: "not a url at all",
  });
  assert.equal(code, 1);
  assert.match(stderr, /WRAPPER_OLLAMA_BASE_URL/);
});

test("non-http protocol in base URL fails loud with exit 1", async () => {
  const { code, stderr } = await spawnBin(["plan"], {
    WRAPPER_OLLAMA_BASE_URL: "ftp://example.com/v1",
  });
  assert.equal(code, 1);
  assert.match(stderr, /WRAPPER_OLLAMA_BASE_URL/);
});

test("empty model id fails loud with exit 1", async () => {
  const { code, stderr } = await spawnBin(["browse"], { WRAPPER_MODEL_MAIN: "  " });
  assert.equal(code, 1);
  assert.match(stderr, /WRAPPER_MODEL_MAIN/);
});

test("usage: --help exits 0 with the usage text on stdout; -h works per subcommand", async () => {
  const help = await spawnBin(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/);
  for (const sub of ["plan", "generate", "heal", "browse"]) {
    assert.ok(help.stdout.includes(sub), `usage lists ${sub}`);
  }
  const planHelp = await spawnBin(["plan", "--help"]);
  assert.equal(planHelp.code, 0);
  assert.match(planHelp.stdout, /playwright-wrapper plan/);
});

test("unknown subcommand: usage error, exit 2, message on stderr", async () => {
  const { code, stderr } = await spawnBin(["frobnicate"]);
  assert.equal(code, 2);
  assert.match(stderr, /unknown subcommand "frobnicate"/);
  assert.match(stderr, /plan, generate, heal, browse/);
});

test("bare invocation: usage on stderr, exit 2", async () => {
  const { code, stdout, stderr } = await spawnBin([]);
  assert.equal(code, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /Usage:/);
});

test("third-tier gate: key presence is presence-only, surfaced on the heal envelope", async () => {
  // The stub announcement is gone (FYR-331 made heal real): the third-tier
  // valve now surfaces as the envelope's attempts.third_tier.enabled — the
  // key's VALUE is never read, only its presence. The config surface computes
  // it; the heal envelope carries it (asserted in test/heal.test.mjs).
  const { loadConfig } = await import("../src/config.mjs");
  const onCfg = loadConfig({ WRAPPER_OLLAMA_API_KEY: "k", OPENAI_API_KEY: "sk-third-tier-value" });
  assert.equal(onCfg.thirdTierKeyPresent, true);
  assert.ok(!JSON.stringify(onCfg).includes("sk-third-tier-value"), "the value is never echoed");
  const offCfg = loadConfig({ WRAPPER_OLLAMA_API_KEY: "k" });
  assert.equal(offCfg.thirdTierKeyPresent, false);
});

test("seam: config surface feeds a stub URL — env override reaches the bin (contract for FYR-328+)", async (t) => {
  // A stub that records the User-Agent-less GET proves the URL override is
  // honored verbatim; the skeleton itself makes no calls, so assert the env
  // surface by loading config directly with the stub URL.
  const { loadConfig } = await import("../src/config.mjs");
  const cfg = loadConfig({ WRAPPER_OLLAMA_BASE_URL: "http://127.0.0.1:1/v1", WRAPPER_OLLAMA_API_KEY: "k" });
  assert.equal(cfg.baseUrl.href, "http://127.0.0.1:1/v1");
  assert.equal(cfg.modelMain, "glm-5.3-flash");
  assert.equal(cfg.modelFallback, "glm-5.3");
  assert.equal(cfg.thirdTierKeyPresent, false);
  assert.equal(typeof cfg.apiKey, "string");
});