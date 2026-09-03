// LLM client (FYR-328): every word the wrapper says to an LLM goes through
// this one client. OpenAI-compatible chat completions against the config
// surface from FYR-326.
//
// Fallback discipline (FYR-248): main model first; the fallback is engaged
// exactly once on error/timeout/empty-content — never on a *validating*
// output, never per-task splitting. n_fallback = 1.
//
// Reasoning budget (FYR-246): both models are reasoning models — a spendthrift
// reasoning prefix must never end in `content: ""` with `finish_reason:
// "length"`. minTokens reserves room so a normal-length completion is never
// truncated before content; a genuinely long output still finishes with
// `length` — that is reported as a failure (retryable), not repaired silently.
//
// Key hygiene: the API key never appears in logs or error messages.
import { loadConfig } from "./config.mjs";

export class LlmError extends Error {
  /**
   * @param {string} message - names what failed; NEVER includes the key
   * @param {object} [meta] - { phase: "main"|"fallback"|"third-tier", cause?, attempts?, budgetExhausted? }
   */
  constructor(message, { phase, cause, attempts, budgetExhausted } = {}) {
    super(message);
    this.name = "LlmError";
    this.phase = phase;
    this.cause = cause;
    this.attempts = attempts;
    this.budgetExhausted = budgetExhausted === true;
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** Reserve room for the reasoning prefix: below this, `content: ""` +
 * `finish_reason: "length"` is not a model verdict, it's a mis-budgeted call. */
export const MIN_COMPLETION_TOKENS = 100;

/**
 * One LLM call with fallback-on-failure.
 *
 * @param {object} opts
 * @param {string} opts.system - system prompt
 * @param {string|Array} opts.user - user content
 * @param {number} [opts.maxTokens] - completion budget (incl. reasoning prefix)
 * @param {number} [opts.timeoutMs]
 * @param {object} [opts.config] - pre-loaded config (defaults to loadConfig())
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{content: string, model: string, usage: object, raw: object}>}
 *   `model` names which model actually produced the content.
 */
export async function complete({ system, user, maxTokens = 4096, timeoutMs = DEFAULT_TIMEOUT_MS, config, signal } = {}) {
  const cfg = config || loadConfig();
  const apiKey = cfg.apiKey;
  const budget = Math.max(maxTokens, MIN_COMPLETION_TOKENS);

  const call = (model) => callOnce({ baseUrl: cfg.baseUrl, apiKey, model, system, user, maxTokens: budget, timeoutMs, signal });

  let mainError;
  try {
    const res = await callWithRetries(call, cfg.modelMain, "main");
    return res;
  } catch (err) {
    mainError = err;
  }

  // Fallback: exactly once, on failure only. Never on a validating output —
  // callers validate the returned content themselves; a validation failure
  // surfaces to the caller as data, it is not this client's business.
  try {
    const res = await callOnce({ baseUrl: cfg.baseUrl, apiKey, model: cfg.modelFallback, system, user, maxTokens: budget, timeoutMs, signal });
    return { ...res, fallbackFrom: cfg.modelMain, mainError: summarize(mainError) };
  } catch (fallbackErr) {
    throw new LlmError(
      `LLM call failed on main "${cfg.modelMain}" (${summarize(mainError)}) and fallback "${cfg.modelFallback}" (${summarize(fallbackErr)})`,
      { phase: "fallback", attempts: 2 },
    );
  }
}

function summarize(err) {
  // Error messages never contain the key — errors carry phase + HTTP status + a reason class.
  if (err instanceof LlmError) return `${err.phase}:${err.message}`;
  return err.message;
}

async function callWithRetries(fn, model, phase) {
  // Bounded transport infra-retries (FYR-294: no model-fallback inside a tier;
  // the ladder belongs to the caller). 2 attempts total for transient errors.
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fn(model, phase);
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}

function isTransient(err) {
  if (err instanceof LlmError) return err.attempts?.transport === true;
  return false;
}

async function callOnce({ baseUrl, apiKey, model, system, user, maxTokens, timeoutMs, signal }) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onOuterAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const res = await fetch(new URL("chat/completions", baseUrl), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new LlmError(`HTTP ${res.status} ${classifyHttp(res.status)}`, {
        phase: "main",
        attempts: { transport: res.status === 429 || res.status >= 500 },
      });
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice) throw new LlmError("response has no choices", { phase: "main" });

    const content = choice.message?.content ?? "";
    const finish = choice.finish_reason;

    // Reasoning-budget rule: an empty content with finish_reason "length"
    // means the reasoning prefix ate the whole budget. Retry once with a
    // doubled budget — and if still empty, fail loud (never repair silently).
    if (content === "" && finish === "length" && maxTokens < 8192) {
      return callOnce({ baseUrl, apiKey, model, system, user, maxTokens: maxTokens * 2, timeoutMs, signal });
    }
    if (content === "" && finish === "length") {
      throw new LlmError(`reasoning prefix exhausted even the doubled budget (${maxTokens} tokens) — empty content, finish_reason length`, { phase: "main" });
    }

    return { content, model: data.model || model, usage: data.usage || {}, raw: data };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (err?.name === "AbortError") {
      const cause = signal?.aborted ? "caller abort" : "timeout";
      throw new LlmError(cause, { phase: "main", attempts: { transport: cause === "timeout" } });
    }
    throw new LlmError(`transport failure: ${err.message}`, { phase: "main", attempts: { transport: true } });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * The third-tier call (FYR-257/294): ONE GPT-5.6 attempt, the top of the
 * heal ladder. No model fallback — falling back to an exhausted Ollama model
 * is a non-retry (294: violates input-must-differ). Bounded transport
 * infra-retries on the SAME call are kept (429/5xx/timeout), consistent with
 * the main client; a persistent error is the caller's `errored` outcome.
 *
 * Budget: the ~512-token completion cap (294) is the INITIAL budget. The
 * reasoning-budget rule from FYR-328 applies unchanged — an empty content
 * with finish_reason "length" is a mis-budgeted call, not a verdict, and is
 * retried with a doubled budget (bounded, loud-fatal at the end). This is
 * budget repair inside one logical attempt, never a model fallback and
 * never a re-consult; persistent burn is v1 telemetry (294).
 *
 * Key hygiene: the OPENAI_API_KEY value never appears in logs or errors.
 *
 * @param {object} opts
 * @param {string} opts.system
 * @param {string} opts.user
 * @param {number} [opts.maxTokens] - initial completion budget (default 512)
 * @param {number} [opts.timeoutMs]
 * @param {object} opts.config - pre-loaded config (thirdTier* fields)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{content: string, model: string, usage: object, raw: object}>}
 */
export async function completeThirdTier({ system, user, maxTokens = 512, timeoutMs = DEFAULT_TIMEOUT_MS, config, signal } = {}) {
  const cfg = config || loadConfig();
  // The third-tier key is read from the environment at call time — its value
  // never enters the config object (FYR-326's presence-only surface) and
  // never appears in logs or error messages.
  const apiKey = typeof process.env.OPENAI_API_KEY === "string" ? process.env.OPENAI_API_KEY : "";
  if (!cfg.thirdTierKeyPresent || apiKey.trim() === "") {
    throw new LlmError("third tier disabled: OPENAI_API_KEY is not present — the gate is key-presence (FYR-257); this call should never have been reached", { phase: "third-tier" });
  }
  const model = cfg.thirdTierModel;
  const budget = Math.max(maxTokens, MIN_COMPLETION_TOKENS);

  const call = (maxTokens_, phase) =>
    callThirdTierOnce({
      baseUrl: cfg.thirdTierBaseUrl,
      apiKey,
      model,
      system,
      user,
      maxTokens: maxTokens_,
      timeoutMs,
      signal,
      phase,
    });

  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await call(budget, "third-tier");
    } catch (err) {
      lastErr = err;
      // Reasoning-budget repair: empty content + finish length with room to
      // double is a mis-budgeted call, not a model verdict (FYR-328 rule).
      if (err instanceof LlmError && err.budgetExhausted && budget < 8192) {
        return call(budget * 2, "third-tier");
      }
      if (!isTransient(err)) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}

async function callThirdTierOnce({ baseUrl, apiKey, model, system, user, maxTokens, timeoutMs, signal, phase }) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onOuterAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const res = await fetch(new URL("chat/completions", baseUrl), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      // Chat Completions carries no tools here — `reasoning_effort: "max"` is
      // safe with this endpoint shape (the tools incompatibility needs tools).
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, reasoning_effort: "max" }),
    });

    if (!res.ok) {
      const status = res.status;
      await res.text().catch(() => "");
      throw new LlmError(`HTTP ${status} ${classifyHttp(status)}`, {
        phase,
        attempts: { transport: status === 429 || status >= 500 },
      });
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice) throw new LlmError("response has no choices", { phase });

    const content = choice.message?.content ?? "";
    const finish = choice.finish_reason;
    if (content === "" && finish === "length") {
      throw new LlmError(`reasoning prefix exhausted the third-tier budget (${maxTokens} tokens) — empty content, finish_reason length`, { phase, budgetExhausted: true });
    }
    return { content, model: data.model || model, usage: data.usage || {}, raw: data };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (err?.name === "AbortError") {
      const cause = signal?.aborted ? "caller abort" : "timeout";
      throw new LlmError(cause, { phase, attempts: { transport: cause === "timeout" } });
    }
    throw new LlmError(`transport failure: ${err.message}`, { phase, attempts: { transport: true } });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

function classifyHttp(status) {
  if (status === 401 || status === 403) return "auth rejected by endpoint (check WRAPPER_OLLAMA_API_KEY)";
  if (status === 429) return "rate limited";
  if (status >= 500) return "endpoint error";
  return "request rejected";
}

/**
 * One LLM chat call with full message control + tools (the FYR-333 browse
 * loop's primitive). Same fallback discipline as complete(): main model,
 * fallback engaged exactly once on error/timeout — never on a validating
 * output. The caller owns validation.
 *
 * @param {object} opts
 * @param {Array} opts.messages - full message array (system/user/assistant/tool)
 * @param {Array} [opts.tools] - OpenAI function-tool definitions
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs]
 * @param {object} [opts.config]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{message: object, toolCalls: Array, finish: string, model: string, usage: object, raw: object, fallbackFrom?: string}>}
 */
export async function completeChat({ messages, tools, maxTokens = 4096, timeoutMs = DEFAULT_TIMEOUT_MS, config, signal } = {}) {
  const cfg = config || loadConfig();
  const apiKey = cfg.apiKey;
  const budget = Math.max(maxTokens, MIN_COMPLETION_TOKENS);

  const call = (model, phase) =>
    callChatOnce({ baseUrl: cfg.baseUrl, apiKey, model, messages, tools, maxTokens: budget, timeoutMs, signal, phase });

  let mainError;
  try {
    return await callWithRetries((model) => call(model, "main"), cfg.modelMain, "main");
  } catch (err) {
    mainError = err;
  }
  try {
    const res = await call(cfg.modelFallback, "fallback");
    return { ...res, fallbackFrom: cfg.modelMain, mainError: summarize(mainError) };
  } catch (fallbackErr) {
    throw new LlmError(
      `LLM call failed on main "${cfg.modelMain}" (${summarize(mainError)}) and fallback "${cfg.modelFallback}" (${summarize(fallbackErr)})`,
      { phase: "fallback", attempts: 2 },
    );
  }
}

async function callChatOnce({ baseUrl, apiKey, model, messages, tools, maxTokens, timeoutMs, signal, phase }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onOuterAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onOuterAbort, { once: true });

  const body = { model, messages, max_tokens: maxTokens };
  if (tools) body.tools = tools;

  try {
    const res = await fetch(new URL("chat/completions", baseUrl), {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const status = res.status;
      await res.text().catch(() => "");
      throw new LlmError(`HTTP ${status} ${classifyHttp(status)}`, {
        phase,
        attempts: { transport: status === 429 || status >= 500 },
      });
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice) throw new LlmError("response has no choices", { phase });
    const message = choice.message ?? {};
    return {
      message,
      toolCalls: choice.message?.tool_calls ?? [],
      finish: choice.finish_reason,
      model: data.model || model,
      usage: data.usage || {},
      raw: data,
    };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (err?.name === "AbortError") {
      const cause = signal?.aborted ? "caller abort" : "timeout";
      throw new LlmError(cause, { phase, attempts: { transport: cause === "timeout" } });
    }
    throw new LlmError(`transport failure: ${err.message}`, { phase, attempts: { transport: true } });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}