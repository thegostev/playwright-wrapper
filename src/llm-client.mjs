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
   * @param {object} [meta] - { phase: "main"|"fallback", cause?, attempts? }
   */
  constructor(message, { phase, cause, attempts } = {}) {
    super(message);
    this.name = "LlmError";
    this.phase = phase;
    this.cause = cause;
    this.attempts = attempts;
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

function classifyHttp(status) {
  if (status === 401 || status === 403) return "auth rejected by endpoint (check WRAPPER_OLLAMA_API_KEY)";
  if (status === 429) return "rate limited";
  if (status >= 500) return "endpoint error";
  return "request rejected";
}