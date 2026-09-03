// Config surface for the playwright-wrapper CLI (FYR-326).
//
// The entire LLM configuration comes from the environment — base URL, model
// ids, API key. Validation is cheap and loud, and it runs before anything
// else. Key values are never logged, never persisted, never echoed: errors
// name the env var, never the value.
//
// Defaults per FYR-325: hosted Ollama Cloud endpoint, main
// `glm-5.3-flash:cloud`, fallback `glm-5.3:cloud` (fallback-on-failure only).

const DEFAULT_BASE_URL = "https://ollama.com/v1";
const DEFAULT_MODEL_MAIN = "glm-5.3-flash:cloud";
const DEFAULT_MODEL_FALLBACK = "glm-5.3:cloud";

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
    this.exitCode = 1;
  }
}

/**
 * Read + validate the LLM config from env. Throws ConfigError with a
 * message that names the offending env var — never its value.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{baseUrl: URL, modelMain: string, modelFallback: string, apiKey: string, thirdTierKeyPresent: boolean}}
 */
export function loadConfig(env = process.env) {
  const baseUrlRaw = env.WRAPPER_OLLAMA_BASE_URL || DEFAULT_BASE_URL;

  let baseUrl;
  try {
    baseUrl = new URL(baseUrlRaw);
  } catch {
    throw new ConfigError(
      `WRAPPER_OLLAMA_BASE_URL is not a valid URL (got a value that does not parse); must be an absolute http(s) URL, e.g. ${DEFAULT_BASE_URL}`,
    );
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new ConfigError(
      `WRAPPER_OLLAMA_BASE_URL must be an absolute http(s) URL (got protocol "${baseUrl.protocol}")`,
    );
  }

  const modelMain = env.WRAPPER_MODEL_MAIN || DEFAULT_MODEL_MAIN;
  const modelFallback = env.WRAPPER_MODEL_FALLBACK || DEFAULT_MODEL_FALLBACK;
  for (const [name, value] of [
    ["WRAPPER_MODEL_MAIN", modelMain],
    ["WRAPPER_MODEL_FALLBACK", modelFallback],
  ]) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new ConfigError(`${name} is empty — set it to a non-empty model id`);
    }
  }

  const apiKey = env.WRAPPER_OLLAMA_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new ConfigError(
      "WRAPPER_OLLAMA_API_KEY is not set — the wrapper needs an Ollama Cloud API key to call the LLM",
    );
  }

  // Third tier (FYR-257): key-presence gate only. The value is never read here.
  const thirdTierKeyPresent =
    typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim() !== "";

  return { baseUrl, modelMain, modelFallback, apiKey, thirdTierKeyPresent };
}

/** Usage text. Exit-code contract: 0 on help, 2 on usage error, 1 on config error. */
export const USAGE = `playwright-wrapper — LLM-driven Playwright test generation, healing, and browsing

Usage:
  playwright-wrapper <subcommand> [options]

Subcommands:
  plan      Drive the target page, snapshot it, and have the model emit a
            candidate plan (keyed-line step list) on stdout for review.
  generate  Consume the approved plan verbatim on stdin; compile it into a
            Playwright spec + write the stamped pair into the consumer repo.
  heal      Consume a self-locating CI run and walk the heal ladder,
            proposing {step_id, locator} patches; write .heal.md records.
  browse    Run the planless ReAct browsing loop ending in submit_extraction;
            emit the contract-version 2 outcome envelope on stdout.

Options:
  -h, --help   Show this help, or help for a subcommand.

LLM configuration (environment only — never flags, never logged):
  WRAPPER_OLLAMA_BASE_URL     Base URL of the OpenAI-compatible endpoint
                              (default: ${DEFAULT_BASE_URL})
  WRAPPER_MODEL_MAIN          Main model id (default: ${DEFAULT_MODEL_MAIN})
  WRAPPER_MODEL_FALLBACK      Fallback model id, engaged on failure only
                              (default: ${DEFAULT_MODEL_FALLBACK})
  WRAPPER_OLLAMA_API_KEY      Ollama Cloud API key (required; value never printed)
  OPENAI_API_KEY              If present, enables the third-tier escalation valve
`;