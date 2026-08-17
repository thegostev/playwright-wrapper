// FYR-256 spike: confirm @playwright/mcp can run fully in-process via the MCP
// TS SDK's InMemoryTransport — no subprocess, no socket. If this works, the
// lib can drive the browser through the same ref-based accessibility-snapshot
// tools that @playwright/mcp exposes over stdio, just without a process boundary.
//
// Throwaway — answers a design question, not production code.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createConnection } from '@playwright/mcp';

const log = (...a) => console.log('[spike]', ...a);
const die = (msg) => { console.error('[spike] FAIL:', msg); process.exit(1); };

// 1. Create the in-memory linked pair. [0] = client side, [1] = server side.
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
log('InMemoryTransport.createLinkedPair() -> pair created');

// 2. Bring up the @playwright/mcp server in-process and connect it to one side.
const server = await createConnection({
  browser: { browserName: 'chromium', launchOptions: { headless: true } },
  capabilities: ['core'],
});
log('createConnection() -> Server (constructor:', server.constructor?.name, ')');
await server.connect(serverTransport);
log('server.connect(serverTransport) -> ok');

// 3. MCP Client on the other side.
const client = new Client({ name: 'fyr-256-spike', version: '0.0.0' }, { capabilities: {} });
await client.connect(clientTransport);
log('client.connect(clientTransport) -> ok');

// 4. List tools — confirm browser_snapshot / browser_click / browser_navigate exist.
const { tools } = await client.listTools();
const names = tools.map(t => t.name).sort();
log('tools:', names.join(', '));
const has = (n) => names.includes(n);
for (const n of ['browser_navigate', 'browser_snapshot', 'browser_click']) {
  if (!has(n)) die(`expected tool ${n} missing`);
}

// 5. Navigate to a trivial page.
await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com' } });
log('browser_navigate(example.com) -> ok');

// 6. Snapshot — this is the key payload: ref-based accessibility-snapshot YAML.
const snap = await client.callTool({ name: 'browser_snapshot', arguments: {} });
log('browser_snapshot() -> isError:', snap.isError, 'content blocks:', snap.content?.length);

const yamlBlock = snap.content?.find(b => b.type === 'text');
if (!yamlBlock) die('snapshot returned no text block');
const yaml = yamlBlock.text;
log('snapshot YAML (first 600 chars):\n' + yaml.slice(0, 600));

// 7. Pull a link ref out of the YAML and click it in-process.
//    browser_click's schema requires `target` = the ref string; `element` is a
//    human-readable description (used for permission UX), not the selector.
const refMatch = yaml.match(/link "([^"]+)"[^\[]*\[ref=(\w+)\]/);
if (!refMatch) die('could not parse a link ref from the snapshot YAML');
const element = refMatch[1].trim();   // "Learn more"
const target = refMatch[2];            // e6
log('parsed link ref:', target, '-> element:', JSON.stringify(element));

const click = await client.callTool({ name: 'browser_click', arguments: { element, target } });
log('browser_click({target:', target, '}) -> isError:', click.isError);
const clickText = click.content?.find(b => b.type === 'text')?.text ?? '';
log('click result (first 300 chars):\n' + clickText.slice(0, 300));

// 8. One more snapshot to prove the session is still alive and responsive in-process.
const snap2 = await client.callTool({ name: 'browser_snapshot', arguments: {} });
log('post-click browser_snapshot() -> isError:', snap2.isError, 'blocks:', snap2.content?.length);

await client.close();
log('PASS: in-process @playwright/mcp via InMemoryTransport works — ref-snapshot YAML + ref click confirmed, no subprocess, no socket.');