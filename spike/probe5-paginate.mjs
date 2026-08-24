// FYR-303 probe: dump ref-snapshots of candidate paginated boards so we can
// pick spike targets and see which pagination cues a snapshot exposes.
//
// Usage: node spike/probe5-paginate.mjs <url> [outfile-tag]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createConnection } from '@playwright/mcp';
import fs from 'node:fs';

// hard watchdog: exit even if client.close() hangs
setTimeout(() => { console.log('WATCHDOG: force exit'); process.exit(3); }, 90_000).unref();

const url = process.argv[2];
const tag = process.argv[3] || url.replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
const [ct, st] = InMemoryTransport.createLinkedPair();
const server = await createConnection({ browser: { browserName: 'chromium', launchOptions: { headless: true } }, capabilities: ['core'] });
await server.connect(st);
const client = new Client({ name: 'probe5', version: '0' }, { capabilities: {} });
await client.connect(ct);

await client.callTool({ name: 'browser_navigate', arguments: { url } });
const snap = await client.callTool({ name: 'browser_snapshot', arguments: {} });
const yaml = snap.content?.find(b => b.type === 'text')?.text || '';
fs.writeFileSync(`spike/snap-${tag}.yaml`, yaml);
console.log('URL:', url);
console.log('snapshot chars:', yaml.length);
const links = yaml.match(/link [^\[]*\[ref=\w+\]/g) || [];
console.log('link count:', links.length);
console.log('--- pagination cue scan ---');
for (const re of [/next[^\n]*/gi, /previous[^\n]*/gi, /load more[^\n]*/gi, /loading more[^\n]*/gi, /show more[^\n]*/gi, /more jobs[^\n]*/gi, /of \d+[^\n]*/gi, /page \d+[^\n]*/gi, /\b\d+ (jobs|open roles|positions|results)[^\n]*/gi]) {
  const hits = yaml.match(re) || [];
  if (hits.length) console.log(re.source, '=>', hits.slice(0, 4).map(h => JSON.stringify(h.slice(0, 110))).join(' '));
}
console.log('--- last 600 chars (footer often holds the pager) ---');
console.log(yaml.slice(-600));
await client.close();
process.exit(0);
