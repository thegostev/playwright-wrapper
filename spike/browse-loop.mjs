// FYR-258 spike: run the LLM browsing loop on a REAL public career page.
//
// Goal: empirically test whether the hosted Ollama Cloud models (main
// minimax-m3, fallback glm-5.2) can drive an agentic browsing loop —
// navigate + ref-snapshot + click + self-judge done — end-to-end on a real
// public page, with no assertion oracle. The "done" signal is the model
// calling `submit_extraction` with the list of open roles.
//
// Throwaway — answers a design question, not production code.
//
// Usage: node spike/browse-loop.mjs [url] [model]
//   url   defaults to https://jobs.fortum.com (Fortum public careers board)
//   model defaults to the main/fallback chain (minimax-m3 -> glm-5.2)

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createConnection } from '@playwright/mcp';

const BASE = 'https://ollama.com/v1';
const KEY = process.env.OLLAMA_API_KEY;
const MODEL_CHAIN = ['minimax-m3', 'glm-5.2']; // main, then fallback-on-failure
const MAX_STEPS = 16;
const STEP_TIMEOUT_MS = 120_000;

const log = (...a) => console.log('[loop]', ...a);
const hr = () => console.log('\n' + '='.repeat(78));

if (!KEY) { console.error('OLLAMA_API_KEY not set'); process.exit(1); }

const targetUrl = process.argv[2] || 'https://jobs.fortum.com';
const forcedModel = process.argv[3] || null;
log('target:', targetUrl);
log('models:', forcedModel || MODEL_CHAIN.join(' -> (fallback) -> '));

// --- 1. Bring up @playwright/mcp in-process (FYR-256 PASS bridge) -----------
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = await createConnection({
  browser: { browserName: 'chromium', launchOptions: { headless: true } },
  capabilities: ['core'],
});
await server.connect(serverTransport);
const client = new Client({ name: 'fyr-258-spike', version: '0.0.0' }, { capabilities: {} });
await client.connect(clientTransport);
const { tools: mcpTools } = await client.listTools();
log('mcp tools available:', mcpTools.length);

// --- 2. Build the OpenAI tool list ----------------------------------------
// Subset of browser_* tools (so the model's tool space is focused) + our
// terminal submit_extraction. Schemas come straight from the MCP tools'
// inputSchema (avoids the `target` vs `ref` gotcha — the real schema tells
// the model what to send).
const BROWSER_ALLOW = new Set([
  'browser_navigate', 'browser_snapshot', 'browser_click',
  'browser_type', 'browser_press_key', 'browser_take_screenshot',
]);
const tools = mcpTools
  .filter(t => BROWSER_ALLOW.has(t.name))
  .map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
tools.push({
  type: 'function',
  function: {
    name: 'submit_extraction',
    description: 'Submit the final extracted list of open roles and finish. Call this ONCE when you have collected the roles visible on the page. Each role has a title, a location, and a link (absolute URL if possible). If the page lists no open roles, submit an empty array.',
    parameters: {
      type: 'object',
      properties: {
        roles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              location: { type: 'string' },
              link: { type: 'string' },
            },
            required: ['title', 'location', 'link'],
          },
        },
        notes: { type: 'string', description: 'Optional: confidence, what you tried, anything notable.' },
      },
      required: ['roles'],
    },
  },
});
log('exposed tools:', tools.map(t => t.function.name).join(', '));

// --- 3. System prompt ------------------------------------------------------
const SYSTEM = `You are an autonomous browsing agent driving a real Chromium browser through tools.
Your job: extract the list of OPEN ROLES from a public careers/jobs page.

How the browser tools work:
- browser_navigate({ url }) — go to a URL.
- browser_snapshot() — return an accessibility-tree snapshot of the page as YAML. This is your EYES: it lists every visible element with a ref like [ref=e12]. Links appear as \`- link "Link text" [ref=e7]\`. The snapshot is the only way to see page content.
- browser_click({ element, target }) — click the element whose ref is \`target\` (e.g. "e7"). \`element\` is a human description of what you're clicking.
- browser_type({ element, target, text }) — type text into the element whose ref is \`target\`.
- browser_press_key({ key }) — press a key (e.g. "Enter").
- browser_take_screenshot() — rarely needed; prefer the snapshot.

Strategy:
1. Navigate to the page.
2. Take a snapshot. Read the roles listed. Roles usually appear as links with the job title as the link text and a location nearby.
3. If the full list is visible in one snapshot, extract every role you can see (title, location, link). If the page paginates or hides roles behind a department filter / "Search" button / "Load more", click through to surface them and snapshot again.
4. When you have the roles, call submit_extraction({ roles: [{title, location, link}, ...] }). Link should be the role's URL (absolute). If you cannot find a link for a role, use the page URL.

Rules:
- Act only through the tools. Do not invent roles you did not see in a snapshot.
- Prefer fewer, high-signal snapshots. Don't loop forever — if after a few snapshots you have the visible roles, submit them.
- Call submit_extraction exactly once to finish. An empty array is a valid answer if the page genuinely lists no roles.`;

// --- 4. The loop -----------------------------------------------------------
const messages = [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: `Extract the open roles from this page: ${targetUrl}` },
];

let done = false;
let extracted = null;
const trace = [];
let currentModel = forcedModel || MODEL_CHAIN[0];

for (let step = 1; step <= MAX_STEPS && !done; step++) {
  hr();
  log(`STEP ${step} — model=${currentModel}`);
  let resp;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), STEP_TIMEOUT_MS);
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: currentModel, messages, tools, max_tokens: 4096 }),
      signal: ctrl.signal,
    });
    clearTimeout(to);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    resp = await r.json();
  } catch (e) {
    log('LLM call failed:', String(e.message || e));
    // fallback-on-failure: retry the SAME step with the next model in the chain
    const idx = MODEL_CHAIN.indexOf(currentModel);
    if (!forcedModel && idx >= 0 && idx < MODEL_CHAIN.length - 1) {
      currentModel = MODEL_CHAIN[idx + 1];
      log(`falling back to ${currentModel} and retrying step ${step}`);
      step--; // redo this step
      continue;
    }
    log('NO MORE FALLBACKS — aborting loop');
    trace.push({ step, model: currentModel, error: String(e.message || e) });
    break;
  }

  const msg = resp.choices?.[0]?.message;
  if (!msg) { log('no message in response', JSON.stringify(resp).slice(0, 300)); break; }
  const finish = resp.choices?.[0]?.finish_reason;
  const usage = resp.usage;
  log(`finish=${finish} usage=${JSON.stringify(usage)}`);
  if (msg.reasoning) log(`reasoning: ${String(msg.reasoning).slice(0, 200)}${msg.reasoning.length > 200 ? '…' : ''}`);

  const assistantMsg = { role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls || undefined };
  messages.push(assistantMsg);
  trace.push({ step, model: currentModel, finish, usage, tool_calls: (msg.tool_calls || []).map(tc => tc.function?.name) });

  const calls = msg.tool_calls || [];
  if (calls.length === 0) {
    log('no tool calls — assistant text:', JSON.stringify((msg.content || '').slice(0, 400)));
    if (finish === 'stop') {
      // Model stopped without submitting. Give it one nudge, then give up.
      if (step < MAX_STEPS) {
        messages.push({ role: 'user', content: 'You stopped without calling submit_extraction. Either keep browsing with the tools, or call submit_extraction now with the roles you have (empty array if none).' });
        continue;
      }
    }
    log('giving up — no tool call and no submit');
    break;
  }

  // Execute each tool call.
  for (const tc of calls) {
    const name = tc.function?.name;
    let args = {};
    try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (e) { log('bad tool args JSON:', tc.function?.arguments); }
    log(`>> tool: ${name}  args: ${JSON.stringify(args).slice(0, 160)}`);

    if (name === 'submit_extraction') {
      extracted = args;
      done = true;
      trace.push({ step, event: 'submit_extraction', roles: (args.roles || []).length, notes: args.notes });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ ok: true, received: (args.roles || []).length }) });
      log(`<< submit_extraction: ${(args.roles || []).length} roles${args.notes ? ' notes=' + JSON.stringify(args.notes).slice(0, 120) : ''}`);
      continue;
    }

    let resultText;
    try {
      const r = await client.callTool({ name, arguments: args });
      resultText = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
      if (r.isError) resultText = `ERROR: ${resultText}`;
      // Truncate very large snapshots in the log only (full text still goes to the model).
      const logPreview = resultText.length > 800 ? resultText.slice(0, 400) + `\n…[${resultText.length} chars total]` : resultText;
      log(`<< ${name} isError=${!!r.isError} len=${resultText.length}\n${logPreview.split('\n').slice(0, 12).join('\n')}`);
    } catch (e) {
      resultText = `ERROR calling ${name}: ${String(e.message || e)}`;
      log(`<< ${name} THREW: ${resultText}`);
    }
    messages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
  }
}

hr();
// --- 5. Verdict ------------------------------------------------------------
const roles = Array.isArray(extracted?.roles) ? extracted.roles : [];
log('LOOP END', done ? '(submit_extraction called)' : '(no submit — loop exhausted/aborted)');
log(`roles extracted: ${roles.length}`);
if (roles.length) {
  log('first 5 roles:');
  roles.slice(0, 5).forEach((r, i) => log(`  ${i + 1}. ${JSON.stringify(r)}`));
}

const pass = done && roles.length > 0 && roles.every(r => r.title && (r.link !== undefined));
log(`\nVERDICT: ${pass ? 'PASS' : 'FAIL'}`);
log(pass
  ? `Cloud model (${currentModel}) held the browsing loop and extracted ${roles.length} real roles end-to-end on ${targetUrl}.`
  : `Loop did not close cleanly on ${targetUrl}. done=${done} roles=${roles.length}`);

// Dump the full trace + extracted roles to a file for the resolution comment.
const outDir = process.env.CLAUDE_JOB_DIR ? process.env.CLAUDE_JOB_DIR + '/tmp' : '.';
const fs = await import('node:fs');
const stamp = targetUrl.replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
fs.writeFileSync(`${outDir}/fyr258-trace-${stamp}.json`, JSON.stringify({
  targetUrl, model: currentModel, forcedModel, done, pass, rolesCount: roles.length, roles, trace,
}, null, 2));
log(`trace written: ${outDir}/fyr258-trace-${stamp}.json`);

await client.close();
process.exit(pass ? 0 : 2);