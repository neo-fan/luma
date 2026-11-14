#!/usr/bin/env node
/**
 * T-07 runtime probe: CMS home / category / search / detail via real IPC.
 *
 * Requires: stub server on 127.0.0.1:8787, dev window with CDP on 9222.
 */

const CDP = "http://127.0.0.1:9222/json/list";

const CASES = [
  ["stub_json", "homeContent", [], "page"],
  ["stub_json", "categoryContent", ["1", 1], "page"],
  ["stub_json", "searchContent", ["stub", 1], "page"],
  ["stub_json", "detailContent", ["1"], "list"],
  ["stub_xml", "homeContent", [], "page"],
  ["stub_xml", "categoryContent", ["1", 1], "page"],
  ["stub_xml", "searchContent", ["stub", 1], "page"],
  ["stub_xml", "detailContent", ["1"], "list"],
];

async function waitForPage(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(CDP)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("CDP page target not found");
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    const resolver = pending.get(msg.id);
    if (resolver) {
      pending.delete(msg.id);
      resolver(msg);
    }
  });
  return {
    evaluate(expression) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("evaluate timeout")), 30000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg?.result?.result?.value);
        });
        ws.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        );
      });
    },
    close() {
      ws.close();
    },
  };
}

const page = await waitForPage();
const cdp = await connect(page.webSocketDebuggerUrl);

let ipcReady = false;
for (let i = 0; i < 60; i += 1) {
  const ready = await cdp.evaluate(
    "!!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)",
  );
  if (ready === true) {
    ipcReady = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (!ipcReady) {
  console.error("Tauri IPC not ready");
  process.exit(1);
}

const imported = await cdp.evaluate(`(async () => {
  try {
    const r = await window.__TAURI_INTERNALS__.invoke('config_import', {
      source: { kind: 'url', value: 'http://127.0.0.1:8787/config.json' }
    });
    return 'OK:' + r.sites.length;
  } catch (e) {
    return 'ERR:' + (e.code || e.message);
  }
})()`);
console.log(`${imported === "OK:6" ? "PASS" : "FAIL"}  config_import -> ${imported}`);

let failed = imported === "OK:6" ? 0 : 1;

for (const [site, method, args, kind] of CASES) {
  const expr = `(async () => {
    try {
      const r = await window.__TAURI_INTERNALS__.invoke('spider_invoke', {
        request: { siteKey: '${site}', method: '${method}', args: ${JSON.stringify(args)} }
      });
      const n = Array.isArray(r) ? r.length : (r && Array.isArray(r.list) ? r.list.length : -1);
      return 'OK:' + n;
    } catch (e) {
      return 'ERR:' + (e.code || e.message || String(e));
    }
  })()`;
  const value = await cdp.evaluate(expr);
  const ok = value === "OK:1";
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${site}.${method} (${kind}) -> ${value}`);
}

cdp.close();
console.log(failed === 0 ? "T-07 RUNTIME OK: cms json+xml four methods" : `T-07 RUNTIME FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
