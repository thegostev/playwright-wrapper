// FYR-303 spike: multi-page / paginated / infinite-scroll extraction loop.
//
// Extends FYR-258's browse-loop with: (a) generic task goals (roles | quotes),
// (b) a `pagination` self-report on submit_extraction (the FYR-259 coverage
// telemetry shape, exercised for real), (c) per-step cue instrumentation —
// the loop scans every snapshot for pagination signals (next/disabled-next,
// "Results x–y of z", "Page n of m", load-more) and records what was VISIBLE
// vs what the agent CLAIMS.
//
// Throwaway — answers a design question, not production code.
//
// Usage: node spike/page-loop.mjs <url> <kind> [maxSteps] [model] [expectedCount]
//   kind           roles | quotes
//   expectedCount  ground-truth count scraped out-of-band, for the verdict line

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createConnection } from '@playwright/mcp';

const BASE = 'https://ollama.com/v1';
const KEY = process.env.OLLAMA_API_KEY;
const MODEL_CHAIN = ['minimax-m3', 'glm-5.2'];
const STEP_TIMEOUT_MS = 120_000;
const log = (...a) => console.log('[loop]', ...a);
const hr = () => console.log('\n' + '='.repeat(78));

if (!KEY) { console.error('OLLAMA_API_KEY not set'); process.exit(1); }

const [targetUrl, kind, maxStepsArg, forcedModel, expectedArg] = process.argv.slice(2);
const MAX_STEPS = Number(maxStepsArg) || 26;
const EXPECTED = expectedArg ? Number(expectedArg) : null;
log('target:', targetUrl, '| kind:', kind, '| maxSteps:', MAX_STEPS, '| expected:', EXPECTED);

const TASKS = {
  roles: {
    goal: 'extract the list of ALL open roles from a public jobs board. The board PAGINATES — not all roles are on the first page.',
    itemName: 'roles',
    items: { type: 'object', properties: { title: { type: 'string' }, location: { type: 'string' }, link: { type: 'string' } }, required: ['title', 'link'] },
    itemDesc: 'Each role has a title and a link (absolute URL if possible); location if shown.',
  },
  quotes: {
    goal: 'extract ALL quotes from the entire list on this site. The list PAGINATES or lazy-loads — not all quotes are on the first screen.',
    itemName: 'quotes',
    items: { type: 'object', properties: { text: { type: 'string' }, author: { type: 'string' } }, required: ['text', 'author'] },
    itemDesc: 'Each quote has a text and an author.',
  },
};
const task = TASKS[kind];
if (!task) { console.error('unknown kind:', kind); process.exit(1); }

// --- pagination cue scanner (the "what was visible" instrument) ------------
const CUE_RES = [
  ['next_link', /link "(?:Next|next|Next »|›|→)"[^\n]*/],
  ['next_disabled', /(?:link|button) "(?:Next|next|Next »|›|→)"[^\n]*\[disabled\]/],
  ['prev', /link "(?:Previous|«|Prev)[^\n]*/],
  ['load_more', /(?:button|link) "[^"]*(?:load|show|view) more[^"]*"[^\n]*/i],
  ['of_pages', /(?:page|pages)\s*[-–\d]+\s*of\s*\d+|of \d+ pages/i],
  ['results_range', /results?\s+\d+\s*[–-]\s*\d+\s*of\s*\d+/i],
  ['page_links', /\/url:\s*[^\n]*[?&/]page[=/]\d+/],
];
function scanCues(yaml) {
  const found = {};
  for (const [name, re] of CUE_RES) {
    const m = yaml.match(new RegExp(re.source, re.flags.includes('i') ? 'gi' : 'g'));
    if (m?.length) found[name] = m.slice(0, 3).map(s => s.trim().slice(0, 100));
  }
  return found;
}

// --- browser bridge ----------------------------------------------------------
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = await createConnection({ browser: { browserName: 'chromium', launchOptions: { headless: true } }, capabilities: ['core'] });
await server.connect(serverTransport);
const client = new Client({ name: 'fyr-303-spike', version: '0.0.0' }, { capabilities: {} });
await client.connect(clientTransport);
const { tools: mcpTools } = await client.listTools();
log('mcp tools available:', mcpTools.length);

const BROWSER_ALLOW = new Set([
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_click',
  'browser_type', 'browser_press_key', 'browser_take_screenshot', 'browser_mouse_wheel',
]);
const tools = mcpTools
  .filter(t => BROWSER_ALLOW.has(t.name))
  .map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
tools.push({
  type: 'function',
  function: {
    name: 'submit_extraction',
    description: `Submit the final extracted list and finish. Call this ONCE when you have collected ALL items across ALL pages/screens. ${task.itemDesc}`,
    parameters: {
      type: 'object',
      properties: {
        [task.itemName]: { type: 'array', items: task.items },
        pagination: {
          type: 'object',
          description: 'What you observed about pagination while collecting.',
          properties: {
            pages_visited: { type: 'integer', description: 'How many pages/screens you looked at' },
            last_page_reached: { type: 'boolean', description: 'true only if you saw actual evidence the list ends here (e.g. no Next control, Next disabled, or scrolling stopped adding items)' },
            stated_total: { type: ['integer', 'null'], description: 'Total count if the page states one anywhere (e.g. "Results 1-20 of 66", "Page 1 of 10"), else null' },
            end_cue: { type: ['string', 'null'], description: 'The exact text of the cue you used to decide the list ended, else null' },
          },
          required: ['pages_visited', 'last_page_reached', 'stated_total', 'end_cue'],
        },
        notes: { type: 'string', description: 'Optional: what you tried, anything notable.' },
      },
      required: [task.itemName, 'pagination'],
    },
  },
});

const SYSTEM = `You are an autonomous browsing agent driving a real Chromium browser through tools.
Your job: ${task.goal}

How the browser tools work:
- browser_navigate({ url }) — go to a URL.
- browser_snapshot() — accessibility-tree snapshot of the page as YAML; your EYES. Links appear as \`- link "Link text" [ref=e12]\` with \`/url:\` lines. The snapshot is the ONLY way to see page content.
- browser_click({ element, target }) — click element with ref \`target\`. WARNING: clicking a link that navigates can time out; if so, read its \`/url:\` from the snapshot and browser_navigate to it instead.
- browser_navigate_back() — back button.
- browser_mouse_wheel({ deltaY }) — scroll (deltaY ~800 down). Needed for infinite-scroll / lazy-load lists: after scrolling, snapshot again to see newly loaded items.
- browser_type({ element, target, text }) / browser_press_key({ key }).
- browser_take_screenshot() — rarely needed.

Strategy:
1. Navigate. Snapshot. Extract the items you see.
2. Look for pagination: a "Next" link/button, numbered page links (their /url often ends in ?page=N), a stated total ("Results 1–20 of 66", "Page 1 of 10"), or a list that grows when you scroll.
3. Visit EVERY page (or scroll until nothing new loads), collecting items. Prefer browser_navigate to the next page's URL from its /url: line over clicking.
4. You are done ONLY when you have concrete evidence the list ended: the last numbered page, a disabled/absent Next control, or 2 consecutive scrolls that add no items. Then call submit_extraction with ALL collected items and an honest pagination report.

Rules:
- Act only through the tools. Do not invent items you did not see in a snapshot.
- last_page_reached must be false unless you actually observed an end cue.
- Call submit_extraction exactly once to finish.`;

const messages = [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: `${task.goal}\nStart at: ${targetUrl}` },
];

let done = false;
let extracted = null;
let currentModel = forcedModel || MODEL_CHAIN[0];
const trace = [];
const cueLog = []; // per-step: what pagination cues were visible
let fallbackUsed = false;

setTimeout(() => { console.log('WATCHDOG: force exit'); process.exit(3); }, 25 * 60_000).unref();

for (let step = 1; step <= MAX_STEPS && !done; step++) {
  hr();
  log(`STEP ${step} — model=${currentModel}  messages=${messages.length}`);
  let resp;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), STEP_TIMEOUT_MS);
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: currentModel, messages, tools, max_tokens: 8192 }),
      signal: ctrl.signal,
    });
    clearTimeout(to);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    resp = await r.json();
  } catch (e) {
    log('LLM call failed:', String(e.message || e));
    const idx = MODEL_CHAIN.indexOf(currentModel);
    if (!forcedModel && idx >= 0 && idx < MODEL_CHAIN.length - 1) {
      currentModel = MODEL_CHAIN[idx + 1];
      fallbackUsed = true;
      log(`falling back to ${currentModel} and retrying step ${step}`);
      step--;
      continue;
    }
    trace.push({ step, error: String(e.message || e) });
    break;
  }

  const msg = resp.choices?.[0]?.message;
  if (!msg) { log('no message in response'); break; }
  const finish = resp.choices?.[0]?.finish_reason;
  const usage = resp.usage;
  log(`finish=${finish} usage=${JSON.stringify(usage)}`);
  messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls || undefined });
  trace.push({ step, model: currentModel, finish, usage, tool_calls: (msg.tool_calls || []).map(tc => ({ name: tc.function?.name, args: (tc.function?.arguments || '').slice(0, 80) })) });

  const calls = msg.tool_calls || [];
  if (calls.length === 0) {
    log('no tool calls — text:', JSON.stringify((msg.content || '').slice(0, 300)));
    if (finish === 'stop' && step < MAX_STEPS) {
      messages.push({ role: 'user', content: `You stopped without calling submit_extraction. Keep browsing, or call submit_extraction now with everything you collected (${task.itemName} array + pagination report).` });
      continue;
    }
    break;
  }

  for (const tc of calls) {
    const name = tc.function?.name;
    let args = {};
    try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { log('bad tool args JSON:', tc.function?.arguments); }
    log(`>> tool: ${name}  args: ${JSON.stringify(args).slice(0, 140)}`);

    if (name === 'submit_extraction') {
      extracted = args;
      done = true;
      const items = args[task.itemName] || [];
      trace.push({ step, event: 'submit_extraction', count: items.length, pagination: args.pagination, notes: args.notes });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ ok: true, received: items.length }) });
      log(`<< submit_extraction: ${items.length} ${task.itemName}  pagination=${JSON.stringify(args.pagination)}`);
      continue;
    }

    let resultText;
    try {
      const r = await client.callTool({ name, arguments: args });
      resultText = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
      if (r.isError) resultText = `ERROR: ${resultText}`;
      if (name === 'browser_snapshot') {
        const cues = scanCues(resultText);
        cueLog.push({ step, url: (resultText.match(/Page URL: (\S+)/) || [])[1], cues });
        log(`<< snapshot len=${resultText.length} cues=${JSON.stringify(Object.keys(cues))}`);
      } else {
        log(`<< ${name} len=${resultText.length}${r.isError ? ' ERROR' : ''} ${resultText.slice(0, 160).replace(/\n/g, ' ')}`);
      }
    } catch (e) {
      resultText = `ERROR calling ${name}: ${String(e.message || e)}`;
      log(`<< ${name} THREW: ${resultText.slice(0, 200)}`);
    }
    messages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
  }
}

hr();
const items = Array.isArray(extracted?.[task.itemName]) ? extracted[task.itemName] : [];
const pgn = extracted?.pagination || null;
log('LOOP END', done ? '(submitted)' : '(no submit)');
log(`items extracted: ${items.length}${EXPECTED ? `  (ground truth: ${EXPECTED})` : ''}`);
log('pagination self-report:', JSON.stringify(pgn));
log('cue log (what was actually visible):');
for (const c of cueLog) log(`  step ${c.step}  ${c.url || ''}  ${JSON.stringify(c.cues)}`);
if (items.length) items.slice(0, 3).forEach((r, i) => log(`  ${i + 1}. ${JSON.stringify(r).slice(0, 140)}`));

const countOK = EXPECTED == null ? items.length > 0 : items.length >= EXPECTED * 0.9;
const pass = done && countOK;
log(`\nVERDICT: ${pass ? 'PASS' : 'FAIL'}  (${items.length}${EXPECTED ? `/${EXPECTED}` : ''} ${task.itemName}, model=${currentModel}${fallbackUsed ? ' [fell back]' : ''})`);

const outDir = process.env.CLAUDE_JOB_DIR ? process.env.CLAUDE_JOB_DIR + '/tmp' : '.';
const fs = await import('node:fs');
const stamp = `${targetUrl.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}-${kind}`;
fs.writeFileSync(`${outDir}/fyr303-trace-${stamp}.json`, JSON.stringify({
  targetUrl, kind, model: currentModel, forcedModel, fallbackUsed, done, pass,
  expected: EXPECTED, count: items.length, items, paginationSelfReport: pgn, notes: extracted?.notes, cueLog, trace,
}, null, 2));
log(`trace written: ${outDir}/fyr303-trace-${stamp}.json`);

await client.close();
process.exit(pass ? 0 : 2);
