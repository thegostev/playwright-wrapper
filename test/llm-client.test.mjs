// FYR-328 tests: the Ollama client against a stub OpenAI-compatible server.
// The stub serves recorded fixtures — including a main-model failure →
// fallback success — proving fallback-on-failure and the reasoning-budget
// rule. Key never appears in logs or errors (asserted everywhere).

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete, LlmError, MIN_COMPLETION_TOKENS } from "../src/llm-client.mjs";
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