// FYR-327: in-process browser bridge tests.
//
// These drive the REAL bridge (Chromium headless, in-process @playwright/mcp
// over the MCP SDK's InMemoryTransport — no subprocess, no socket) against
// local `node:http` servers on ephemeral ports. Zero model.
//
// AC#1  navigate → snapshot: ref-based YAML with usable [ref=eN] refs
// AC#2  warmContext idempotent — the cold start lands in the warm-up call,
//       never inside an LLM loop (second call must not re-boot)
// AC#3  click-recovery (the known browser_click network-idle gotcha): a click
//       whose target page never settles → the tool call never returns (MCP
//       client throws -32001) BUT the navigation happened → recoverByHref
//       reads the /url: from the snapshot and navigates directly
// AC#4  tool input schemas confirmed via introspection: click's target is the
//       ref from the page snapshot (not a selector); navigate requires url

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const { BrowserBridge, BridgeError, hrefOfRef, currentUrl, resolveHref } = await import(
  "../src/browser-bridge.mjs"
);

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Bridge home</title></head>
<body>
  <main>
    <h1>Bridge home</h1>
    <a href="/target">open the target page</a>
  </main>
</body>
</html>`;
const TARGET_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Target</title></head>
<body><main><h1>target page</h1></main></body></html>`;

// A local site. `neverEnding: true` makes /target stream forever (the
// network-idle gotcha shape). Pending responses are tracked so cleanup can
// end them — otherwise the test process hangs on open sockets.
function makeSite(t, { neverEnding = false } = {}) {
  const pending = [];
  const site = createServer((req, res) => {
    if (req.url === "/target") {
      if (neverEnding) {
        res.writeHead(200, { "content-type": "text/html" });
        res.write(TARGET_HTML);
        pending.push(res);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(TARGET_HTML);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(INDEX_HTML);
  });
  const cleanup = () => {
    // destroy() (not end()): the browser holds keep-alive sockets to the
    // never-ending response, and a polite end() still leaves them open —
    // the test process would hang after the tests finish.
    for (const res of pending.splice(0)) res.destroy();
    site.closeIdleConnections?.();
  };
  return new Promise((resolve) => {
    site.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${site.address().port}`;
      t.after(() => {
        cleanup();
        site.close();
      });
      resolve({ base, cleanup });
    });
  });
}

function makeBridge(t) {
  const bridge = new BrowserBridge();
  t.after(() => bridge.close());
  return bridge;
}

test("bridge: navigate → snapshot is the ref-based YAML with usable refs (AC#1)", async (t) => {
  const { base } = await makeSite(t);
  const bridge = makeBridge(t);

  await bridge.warmContext(); // cold start happens here, outside any LLM loop
  const navText = await bridge.navigate(`${base}/`);
  assert.match(navText, /Page URL:/, "navigate response carries the page URL");

  const snap = await bridge.snapshot();
  assert.match(snap, /Page URL:/);
  assert.match(snap, /```yaml/, "snapshot is the YAML block format");
  assert.match(snap, /\[ref=e\d+\]/, "snapshot entries carry [ref=eN] tokens");
  assert.match(snap, /heading "Bridge home" \[level=1\]/, "the heading is in the a11y tree");
  const refs = bridge.refs(snap);
  assert.ok(refs.length >= 2, `usable refs parsed (${refs.length}): ${refs.join(",")}`);
  // The link ref is addressable and its href is readable from the snapshot.
  const linkLine = snap.split("\n").find((l) => l.includes("open the target page"));
  const linkRef = linkLine.match(/\[ref=(e\d+)\]/)[1];
  assert.equal(hrefOfRef(snap, linkRef), "/target", "href parses from the /url: child line");
});

test("bridge: warmContext is idempotent — the cold start never sits inside a loop (AC#2)", async (t) => {
  const { base } = await makeSite(t);
  const bridge = makeBridge(t);

  await bridge.warmContext();
  // A second warm inside what would be an LLM loop must not re-boot anything.
  await bridge.warmContext();
  await bridge.warmContext();
  // The bridge still works after repeated warming.
  const navText = await bridge.navigate(`${base}/`);
  assert.match(navText, /Page URL:/);
  assert.equal(currentUrl(navText), `${base}/`, "currentUrl parses the navigate response");
});

test("bridge: click that never settles → timedOut error → href navigation recovers (AC#3)", async (t) => {
  const { base } = await makeSite(t, { neverEnding: true });
  const bridge = makeBridge(t);

  await bridge.navigate(`${base}/`);
  const snap = await bridge.snapshot();
  const linkLine = snap.split("\n").find((l) => l.includes("open the target page"));
  const linkRef = linkLine.match(/\[ref=(e\d+)\]/)[1];
  const href = hrefOfRef(snap, linkRef);
  assert.equal(href, "/target");

  // The click navigates to a page whose response never ends → the settle wait
  // never completes → the MCP client times the call out (-32001). The module
  // surfaces that as BridgeError with timedOut, NOT a hard failure.
  const err = await bridge.click(linkRef, "open the target page link").then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof BridgeError, "the stuck click throws BridgeError");
  assert.equal(err.timedOut, true, "the failure is the -32001 gotcha window");

  // Recovery: navigate the href captured from the pre-click snapshot — the
  // page already navigated during the stuck click, so the fresh snapshot no
  // longer carries the ref (that's WHY the href must come from before). The
  // recovery navigate can itself hit the gotcha (the target IS the never-
  // settling page); recoverByHref verifies arrival via a fresh snapshot.
  const recovery = await bridge.recoverByHref({ href, baseUrl: `${base}/` });
  assert.equal(recovery.recovered, true, "recoverByHref landed on the target");
  assert.equal(recovery.via, `${base}/target`);
  assert.match(recovery.text, /Page URL: .*\/target/, "recovery response names the target URL");
  // The snapshot after recovery shows the target content.
  const afterSnap = await bridge.snapshot();
  assert.match(afterSnap, /heading "target page"/, "recovery landed on the target page");
});

test("bridge: tool schemas via introspection — click takes the snapshot ref, navigate requires url (AC#4)", async (t) => {
  const bridge = makeBridge(t);
  await bridge.warmContext();

  const tools = await bridge.listTools();
  const click = tools.find((tool) => tool.name === "browser_click");
  assert.ok(click, "browser_click is exposed");
  assert.equal(click.inputSchema.properties.target.type, "string");
  assert.match(
    click.inputSchema.properties.target.description,
    /reference from the page snapshot/i,
    "click's target is the ref from the snapshot, not a selector",
  );
  assert.ok(click.inputSchema.properties.element, "click takes a human-readable element description");
  assert.deepEqual(click.inputSchema.required, ["target"]);

  const nav = tools.find((tool) => tool.name === "browser_navigate");
  assert.ok(nav, "browser_navigate is exposed");
  assert.deepEqual(nav.inputSchema.required, ["url"], "navigate requires the url");
});

test("parsers: hrefOfRef walks only the ref's subtree; resolveHref joins base; currentUrl extracts", () => {
  const snap = [
    "### Page",
    "- Page URL: http://127.0.0.1:9/",
    "### Snapshot",
    "```yaml",
    `- generic [active] [ref=e1]:`,
    `  - heading "h" [level=1] [ref=e2]`,
    `  - link "go" [ref=e3] [cursor=pointer]:`,
    `    - /url: /target`,
    `- button "b" [ref=e4]`,
    "```",
  ].join("\n");
  assert.equal(hrefOfRef(snap, "e3"), "/target");
  assert.equal(hrefOfRef(snap, "e2"), null, "non-link refs have no /url child");
  assert.equal(hrefOfRef(snap, "e1"), "/target", "walking from the container finds the first /url descendant (the link's href)");
  assert.equal(hrefOfRef(snap, "e9"), null, "unknown ref → null");
  assert.equal(currentUrl(snap), "http://127.0.0.1:9/");
  assert.equal(resolveHref("http://127.0.0.1:9/", "/target"), "http://127.0.0.1:9/target");
  assert.equal(resolveHref("http://127.0.0.1:9/", "http://example.com/x"), "http://example.com/x");
  assert.equal(resolveHref(null, "/target"), "/target");
});

test("bridge: recoverByHref with no recoverable href reports unrecovered, does not throw", async (t) => {
  const { base } = await makeSite(t);
  const bridge = makeBridge(t);
  await bridge.navigate(`${base}/`);
  const result = await bridge.recoverByHref("e999");
  assert.equal(result.recovered, false);
  assert.match(result.text, /no href recoverable/);
});