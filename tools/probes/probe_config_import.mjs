#!/usr/bin/env node
/**
 * T-05 runtime probe: import all six config shapes through the real IPC.
 *
 * Requires: stub server on 127.0.0.1:8787, dev window with CDP on 9222.
 * Exit 0 only when every shape returns a snapshot with 6 sites.
 */

const CDP = "http://127.0.0.1:9222/json/list";
const PATHS = [
  "/config.json",
  "/config-b64.txt",
  "/config-gzip.txt",
  "/config-encrypted.txt",
  "/config-dialect.json",
  "/config-repos.json",
];

async function waitForPage(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(CDP)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* CDP not ready */
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
  console.error("Tauri IPC not ready in WebView");
  process.exit(1);
}

let failed = 0;

for (const path of PATHS) {
  const url = `http://127.0.0.1:8787${path}`;
  const expr = `(async () => {
    try {
      const r = await window.__TAURI_INTERNALS__.invoke('config_import', {
        source: { kind: 'url', value: '${url}' }
      });
      return 'OK:' + (r && Array.isArray(r.sites) ? r.sites.length : -1);
    } catch (e) {
      return 'ERR:' + (e && (e.code || e.message || String(e)));
    }
  })()`;
  const value = await cdp.evaluate(expr);
  const ok = typeof value === "string" && value === "OK:6";
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${path}  ->  ${value}`);
}

const storeExpr = `(async () => {
  try {
    const before = await window.__TAURI_INTERNALS__.invoke('config_list', {});
    if (!Array.isArray(before) || before.length === 0) return 'ERR:empty list';
    await window.__TAURI_INTERNALS__.invoke('config_remove', { id: before[0].id });
    const after = await window.__TAURI_INTERNALS__.invoke('config_list', {});
    return 'OK:' + before.length + '->' + after.length;
  } catch (e) {
    return 'ERR:' + (e && (e.code || e.message || String(e)));
  }
})()`;
const storeValue = await cdp.evaluate(storeExpr);
const parts = typeof storeValue === "string" && storeValue.startsWith("OK:")
  ? storeValue.slice(3).split("->").map(Number)
  : [];
const storeOk = parts.length === 2 && Number.isFinite(parts[1]) && parts[1] === parts[0] - 1;
if (!storeOk) failed += 1;
console.log(`${storeOk ? "PASS" : "FAIL"}  config_list/remove  ->  ${storeValue}`);

cdp.close();
console.log(failed === 0 ? "T-05 RUNTIME OK: six shapes via IPC" : `T-05 RUNTIME FAIL: ${failed} check(s)`);
process.exit(failed === 0 ? 0 : 1);
