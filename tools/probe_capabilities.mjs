#!/usr/bin/env node
/**
 * Runtime half of T-03: ask WebView2 to invoke an unauthorised plugin command
 * and assert the ACL denies it.
 *
 * Requires the dev window to expose CDP (tauri.conf.json additionalBrowserArgs
 * contains --remote-debugging-port=9222).
 *
 * Exit 0 = denied (pass), 1 = allowed or inconclusive.
 */

const CDP = "http://127.0.0.1:9222/json/list";
const EXPR = `(async () => {
  try {
    const r = await window.__TAURI_INTERNALS__.invoke('plugin:shell|spawn', {
      program: 'cmd.exe',
      args: ['/c', 'echo', 'probe']
    });
    return 'ALLOWED:' + JSON.stringify(r);
  } catch (e) {
    return 'DENIED:' + (e && (e.message || String(e)));
  }
})()`;

async function waitForPage(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(CDP);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* CDP not up yet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("CDP page target not found within timeout");
}

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const id = 1;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP evaluate timeout")), 30000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });
  ws.close();
  return result;
}

const page = await waitForPage();
console.log(`target: ${page.url}`);
const res = await evaluate(page.webSocketDebuggerUrl, EXPR);
const value = res?.result?.result?.value ?? JSON.stringify(res);
console.log(`result: ${value}`);

if (typeof value === "string" && value.startsWith("DENIED:")) {
  console.log("CAPABILITY RUNTIME OK: unauthorised shell spawn was denied");
  process.exit(0);
}
console.log("CAPABILITY RUNTIME FAIL: command was allowed or not evaluable");
process.exit(1);
