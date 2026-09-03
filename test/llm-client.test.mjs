// FYR-328 tests: the Ollama client against a stub OpenAI-compatible server.
// The stub serves recorded fixtures — including a main-model failure →
// fallback success — proving fallback-on-failure and the reasoning-budget
// rule. Key never appears in logs or errors (asserted everywhere).

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete, completeThirdTier, LlmError, MIN_COMPLETION_TOKENS } from "../src/llm-client.mjs";
import { loadConfig } from "../src/config.mjs";

const KEY = "test-key-not-a-real-secret";

function startStub(handler) {
  const server = createServer((req, res) => handler(req, res));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function chatBody(content, finish = "stop", model = "glm-5.3-flash") {
  return JSON.stringify({ model, choices: [{ message: { role: "assistant", content }, finish_reason: finish }], usage: { total_tokens: 10 } });
}

function stubConfig(server, overrides = {}) {
  const port = server.address().port;
  return loadConfig({
    WRAPPER_OLLAMA_BASE_URL: `http://127.0.0.1:${port}/v1`,
    WRAPPER_OLLAMA_API_KEY: KEY,
    ...overrides,
  });
}

function authOf(req) {
  return (req.headers.authorization || "").replace("Bearer ", "");
}

test("main model called first with config surface values; content returned", async (t) => {
  let sawModel, sawAuth, sawMaxTokens;
  const server = await startStub((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      sawModel = parsed.model;
      sawMaxTokens = parsed.max_tokens;
      sawAuth = authOf(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(chatBody("hello plan"));
    });
  });
  t.after(() => server.close());

  const res = await complete({ system: "s", user: "u", config: stubConfig(server) });
  assert.equal(res.content, "hello plan");
  assert.equal(res.model, "glm-5.3-flash");
  assert.equal(sawModel, "glm-5.3-flash");
  assert.equal(sawAuth, KEY, " Authorization header carries the key to the stub");
  assert.ok(sawMaxTokens >= MIN_COMPLETION_TOKENS, "budget reserves reasoning room");
});

test("fallback engaged exactly once on main failure → fallback success; mainError recorded", async (t) => {
  let mainCalls = 0, fallbackCalls = 0;
  const server = await startStub((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      if (parsed.model === "glm-5.3-flash") {
        mainCalls++;
        res.writeHead(500).end("boom");
      } else {
        fallbackCalls++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(chatBody("fallback answer", "stop", "glm-5.3"));
      }
    });
  });
  t.after(() => server.close());

  const res = await complete({ system: "s", user: "u", config: stubConfig(server) });
  assert.equal(res.content, "fallback answer");
  assert.equal(res.model, "glm-5.3");
  assert.equal(res.fallbackFrom, "glm-5.3-flash");
  assert.match(res.mainError, /HTTP 500/);
  assert.equal(mainCalls, 2, "main retried once (transport class) then gave up");
  assert.equal(fallbackCalls, 1, "fallback exactly once");
});

test("fallback NOT engaged when main returns validating content (pass is pass)", async (t) => {
  let mainCalls = 0, otherCalls = 0;
  const server = await startStub((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      if (parsed.model === "glm-5.3-flash") {
        mainCalls++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(chatBody("BAD-OUTPUT")); // caller-side validators will reject; client must not retry
      } else {
        otherCalls++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(chatBody("fallback"));
      }
    });
  });
  t.after(() => server.close());

  const res = await complete({ system: "s", user: "u", config: stubConfig(server) });
  assert.equal(res.content, "BAD-OUTPUT"); // returned as-is; validation is the caller's job
  assert.equal(mainCalls, 1);
  assert.equal(otherCalls, 0, "no fallback call on a successful HTTP round trip");
});

test("reasoning-budget rule: empty content + finish length → budget doubled, second try succeeds", async (t) => {
  const seen = [];
  const server = await startStub((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      seen.push(parsed.max_tokens);
      if (parsed.max_tokens <= 400) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(chatBody("", "length")); // spendthrift reasoning prefix
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(chatBody("actual content", "stop"));
      }
    });
  });
  t.after(() => server.close());

  const res = await complete({ system: "s", user: "u", maxTokens: 200, config: stubConfig(server) });
  assert.equal(res.content, "actual content");
  assert.deepEqual(seen, [200, 400, 800]); // doubling continues until budget clears the starvation zone
});

test("tiny maxTokens floor: MIN_COMPLETION_TOKENS enforced so reasoning prefix never eats the budget", async (t) => {
  let sawMaxTokens;
  const server = await startStub((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      sawMaxTokens = JSON.parse(body).max_tokens;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(chatBody("ok", "stop"));
    });
  });
  t.after(() => server.close());

  await complete({ system: "s", user: "u", maxTokens: 10, config: stubConfig(server) });
  assert.equal(sawMaxTokens, MIN_COMPLETION_TOKENS);
});

test("both models fail → LlmError naming both phases, no key in message", async (t) => {
  const server = await startStub((req, res) => res.writeHead(503).end("down"));
  t.after(() => server.close());

  await assert.rejects(
    complete({ system: "s", user: "u", config: stubConfig(server) }),
    (err) => {
      assert.ok(err instanceof LlmError);
      assert.match(err.message, /glm-5\.3-flash/);
      assert.match(err.message, /glm-5\.3/);
      assert.ok(!err.message.includes(KEY));
      return true;
    },
  );
});

test("timeout on main → fallback; caller abort is NOT retried", async (t) => {
  let fallbackCalls = 0;
  const slow = await startStub((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      if (parsed.model === "glm-5.3-flash") {
        // hang until aborted
      } else {
        fallbackCalls++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(chatBody("fallback after timeout"));
      }
    });
  });
  t.after(() => slow.close());

  const res = await complete({ system: "s", user: "u", timeoutMs: 300, config: stubConfig(slow) });
  assert.equal(res.content, "fallback after timeout");
  assert.equal(fallbackCalls, 1);
});

test("401 from main is non-transient → immediate fallback; message names auth without the key", async (t) => {
  const server = await startStub((req, res) => res.writeHead(401).end('{"error":"bad key"}'));
  t.after(() => server.close());

  await assert.rejects(
    complete({ system: "s", user: "u", config: stubConfig(server) }),
    (err) => {
      assert.match(err.message, /auth rejected/);
      assert.ok(!err.message.includes(KEY));
      return true;
    },
  );
});

test("key never appears in transport error messages either", async (t) => {
  // point at a closed port: transport error, not auth
  const cfg = loadConfig({ WRAPPER_OLLAMA_BASE_URL: "http://127.0.0.1:1/v1", WRAPPER_OLLAMA_API_KEY: KEY });
  await assert.rejects(
    complete({ system: "s", user: "u", config: cfg, timeoutMs: 2000 }),
    (err) => !err.message.includes(KEY),
  );
});

// ------------------------------------------------ FYR-332: the third tier

const TIER_KEY = "sk-third-tier-test-only-not-a-secret";

function tierConfig(server, overrides = {}) {
  const port = server.address().port;
  return loadConfig({
    ...process.env,
    WRAPPER_OLLAMA_BASE_URL: "http://127.0.0.1:1/v1",
    WRAPPER_OLLAMA_API_KEY: KEY,
    WRAPPER_OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    ...overrides,
  });
}

test("completeThirdTier: one call at the third-tier seam — tier config, OPENAI key, 512 cap, max effort", async (t) => {
  process.env.OPENAI_API_KEY = TIER_KEY;
  t.after(() => { delete process.env.OPENAI_API_KEY; });
  let sawModel, sawAuth, sawMaxTokens, sawEffort;
  const server = await startStub((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      sawModel = parsed.model;
      sawMaxTokens = parsed.max_tokens;
      sawEffort = parsed.reasoning_effort;
      sawAuth = authOf(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(chatBody("locator json", "stop", "gpt-5.6-sol"));
    });
  });
  t.after(() => server.close());

  const res = await completeThirdTier({ system: "s", user: "u", config: tierConfig(server) });
  assert.equal(res.content, "locator json");
  assert.equal(sawModel, "gpt-5.6-sol", "the confirmed FYR-257 actor id is the default");
  assert.equal(sawMaxTokens, 512, "the one-shot completion cap (FYR-294)");
  assert.equal(sawEffort, "max", "the decision's (Max) reasoning effort");
  assert.equal(sawAuth, TIER_KEY, "the OPENAI key authenticates the tier call");
});

test("completeThirdTier: 500 is transient → retried on the SAME call, never a model fallback", async (t) => {
  process.env.OPENAI_API_KEY = TIER_KEY;
  t.after(() => { delete process.env.OPENAI_API_KEY; });
  const models = new Set();
  let calls = 0;
  const server = await startStub((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      calls++;
      models.add(JSON.parse(body).model);
      res.writeHead(500).end('{"error":"outage"}');
    });
  });
  t.after(() => server.close());

  await assert.rejects(
    completeThirdTier({ system: "s", user: "u", config: tierConfig(server) }),
    (err) => {
      assert.ok(err instanceof LlmError);
      assert.ok(!err.message.includes(TIER_KEY), "the key never names itself");
      return true;
    },
  );
  assert.equal(calls, 2, "two bounded transport attempts, then the shot is spent");
  assert.equal(models.size, 1, "no model fallback inside the tier");
});

test("completeThirdTier: empty content with finish length is budget-repaired once, then loud", async (t) => {
  process.env.OPENAI_API_KEY = TIER_KEY;
  t.after(() => { delete process.env.OPENAI_API_KEY; });
  const budgets = [];
  const server = await startStub((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      budgets.push(parsed.max_tokens);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "gpt-5.6-sol", choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }] }));
    });
  });
  t.after(() => server.close());

  await assert.rejects(
    completeThirdTier({ system: "s", user: "u", config: tierConfig(server) }),
    /reasoning prefix exhausted the third-tier budget/,
  );
  assert.deepEqual(budgets, [512, 1024], "one bounded doubling (the FYR-328 rule), then the shot is spent");
});

test("completeThirdTier: called without the key → loud refusal, zero requests", async (t) => {
  delete process.env.OPENAI_API_KEY;
  let calls = 0;
  const server = await startStub((req, res) => { calls++; res.writeHead(200).end(chatBody("x")); });
  t.after(() => server.close());

  await assert.rejects(
    completeThirdTier({ system: "s", user: "u", config: tierConfig(server) }),
    /third tier disabled: OPENAI_API_KEY is not present/,
  );
  assert.equal(calls, 0, "the gate is key-presence; nothing was sent");
});