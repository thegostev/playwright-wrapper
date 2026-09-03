// In-process browser bridge (FYR-327).
//
// The wrapper sees a page: Chromium boots IN-PROCESS through the Playwright MCP
// bridge (@playwright/mcp's createConnection over the MCP SDK's InMemoryTransport
// — no subprocess, no socket, the proven spike pairing). navigate → snapshot
// returns the ref-based YAML the whole effort standardizes on ([ref=eN] tokens,
// /url: hrefs as children of links).
//
//   - warmContext() boots the bridge before any LLM loop, so the cold start
//     never sits on the critical path of LLM calls (FYR-325 requirement).
//   - navigate() wraps browser_navigate: the tool call NEVER RETURNS when the
//     target page never settles (network-idle wait) — the MCP client throws
//     McpError -32001 Request timed out even though the navigation happened
//     (live-probed). The wrapper surfaces that via BridgeError.timedOut so the
//     caller can recover instead of treating it as a hard failure.
//   - recoverByHref() encodes the known browser_click network-idle gotcha:
//     a click that errors or never settles is followed by reading the link's
//     /url: from the snapshot and navigating directly. Same recovery applies
//     to target="_blank" dead-ends (the click opens a tab we don't follow;
//     direct navigation lands on the same content).
//   - The spawned-stdio MCP server remains the documented escape hatch (not built).
//
// Zero model — pure browser mechanics.

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createConnection } = require('@playwright/mcp');

// The MCP client-side request timeout. This bounds how long a single tool call
// may take before we treat it as the network-idle gotcha and recover.
const CALL_TIMEOUT_MS = 5_000;

export class BridgeError extends Error {
  constructor(message, { tool, cause } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.tool = tool;
    if (cause) this.cause = cause;
  }
}

function textOf(result) {
  return (result.content ?? [])
    .map((c) => (typeof c?.text === 'string' ? c.text : ''))
    .join('');
}

export class BrowserBridge {
  // created lazily; warmContext() is the explicit cold-start site
  #server = null;
  #client = null;

  /**
   * Boot the in-process bridge and warm the browser context. Cold start
   * (~2–3 min with browser download; ~seconds once installed) happens HERE,
   * never inside an LLM loop.
   */
  async warmContext() {
    if (this.#server) return; // idempotent
    this.#server = await createConnection({
      browser: { launchOptions: { headless: true }, isolated: true },
    });
    this.#client = new Client({ name: 'playwright-wrapper', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([this.#server.connect(serverTransport), this.#client.connect(clientTransport)]);
  }

  /**
   * Call a browser tool. Returns the tool result text. A call-level timeout
   * (McpError -32001) throws BridgeError with `timedOut: true` — the action
   * usually DID happen; the caller decides (recoverByHref).
   */
  async #call(name, args) {
    await this.warmContext();
    try {
      const result = await this.#client.callTool({ name, arguments: args ?? {} }, undefined, { timeout: CALL_TIMEOUT_MS });
      if (result?.isError) {
        throw new BridgeError(`browser tool ${name} failed: ${textOf(result).slice(0, 400)}`, { tool: name });
      }
      return textOf(result);
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      if (err?.code === -32001) {
        const timeoutErr = new BridgeError(`browser tool ${name} timed out (network-idle gotcha window)`, { tool: name, cause: err });
        timeoutErr.timedOut = true;
        throw timeoutErr;
      }
      throw new BridgeError(`browser tool ${name} failed: ${err.message}`, { tool: name, cause: err });
    }
  }

  /** Navigate to a URL; returns the tool's response text (includes Page URL). */
  async navigate(url) {
    return this.#call('browser_navigate', { url });
  }

  /**
   * Ref-based accessibility snapshot (YAML with [ref=eN] tokens; link hrefs
   * appear as child `- /url: …` lines). Returns the raw text; helpers parse it.
   */
  async snapshot() {
    return this.#call('browser_snapshot', {});
  }

  /** Click a snapshot ref (e.g. 'e3'). Throws BridgeError on tool failure. */
  async click(ref, elementDescription) {
    return this.#call('browser_click', { element: elementDescription ?? `element ${ref}`, target: ref });
  }

  /** Exposed tool descriptors (introspection surface; schemas included). */
  async listTools() {
    await this.warmContext();
    const { tools } = await this.#client.listTools();
    return tools;
  }

  /**
   * Click recovery (the known browser_click network-idle gotcha, FYR-325):
   * when a click errors or never settles (timedOut), navigate the link's href
   * directly — the click's navigation DID happen or the href still lands right.
   * `target="_blank"` dead-ends recover the same way.
   *
   * Inputs, in preference order:
   *   - href: the `/url:` value read from the snapshot BEFORE the click (the
   *     caller has it in hand; after a stuck click the page has already
   *     navigated, so the fresh snapshot no longer carries the ref).
   *   - baseUrl: the Page URL the click started from (resolve relative hrefs).
   *   - ref: fallback — read the href from a FRESH snapshot (works when the
   *     click failed without navigating, e.g. the actionability TimeoutError).
   * Returns { recovered, via, text }.
   */
  async recoverByHref(input, clickResult = null) {
    // Preferred form: recoverByHref({ href, baseUrl, ref }) — href from the
    // snapshot taken BEFORE the click (after a stuck click the page has already
    // navigated, so the fresh snapshot no longer carries the ref), baseUrl the
    // Page URL the click started from. ref alone falls back to a fresh
    // snapshot lookup (works for non-navigating failures like the
    // actionability TimeoutError). The legacy positional form
    // (ref, clickResponseText) is still accepted.
    let href = null;
    let baseUrl = null;
    if (typeof input === 'string') {
      href = hrefOfRef(await this.snapshot(), input);
      baseUrl = typeof clickResult === 'string' ? currentUrl(clickResult) : null;
    } else {
      href = input.href ?? null;
      baseUrl = input.baseUrl ?? null;
      if (!href && input.ref) href = hrefOfRef(await this.snapshot(), input.ref);
      if (!baseUrl && input.from) baseUrl = currentUrl(input.from);
    }
    if (!href) {
      return { recovered: false, via: null, text: 'no href recoverable for the failed click' };
    }
    const url = resolveHref(baseUrl, href);
    try {
      const text = await this.navigate(url);
      return { recovered: true, via: url, text };
    } catch (err) {
      // Navigating the href can itself hit the gotcha (the target page may be
      // the never-settling one). The navigation still happened — verify arrival
      // with a fresh snapshot instead of failing.
      if (!err.timedOut) throw err;
      const snap = await this.snapshot();
      const landed = currentUrl(snap);
      return { recovered: true, via: url, text: `navigated to ${landed ?? url} (navigate timed out on the unsettled page; snapshot confirms arrival)\n${snap}` };
    }
  }

  /** Parse `[ref=eN]` tokens from a snapshot. */
  refs(snapshotText) {
    return [...snapshotText.matchAll(/\[ref=(e\d+)\]/g)].map((m) => m[1]);
  }

  /** The full snapshot line for a ref, e.g. `- link "go" [ref=e3] [cursor=pointer]:` */
  lineOfRef(snapshotText, ref) {
    return snapshotText.split('\n').find((line) => line.includes(`[ref=${ref}]`)) ?? null;
  }

  /** Close the browser and the connection. Safe to call twice. */
  async close() {
    const server = this.#server;
    const client = this.#client;
    this.#server = null;
    this.#client = null;
    if (client) await client.close().catch(() => {});
    if (server) await server.close().catch(() => {});
  }
}

/** href of a link ref: the child `- /url: …` line under the ref's own line. */
export function hrefOfRef(snapshotText, ref) {
  const lines = snapshotText.split('\n');
  const idx = lines.findIndex((line) => line.includes(`[ref=${ref}]`));
  if (idx === -1) return null;
  const ownIndent = lines[idx].indexOf('-');
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/\/url:\s*(\S+)/);
    if (m) return m[1];
    if (/^\s*-\s/.test(line)) {
      const indent = line.indexOf('-');
      if (indent <= ownIndent) return null; // left the ref's subtree
    }
  }
  return null;
}

/** The current page URL out of a tool response (`- Page URL: …`). */
export function currentUrl(toolText) {
  return toolText.match(/Page URL:\s*(\S+)/)?.[1] ?? null;
}

/** Resolve a snapshot href against the page's URL (absolute hrefs pass through). */
export function resolveHref(baseUrl, href) {
  if (!baseUrl) return href;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}