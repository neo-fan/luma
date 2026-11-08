#!/usr/bin/env node
/** Ad-hoc state dump: config_list + one spider_invoke through the live window. */
const CDP = "http://127.0.0.1:9222/json/list";
const list = await (await fetch(CDP)).json();
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) {
  console.error("no CDP page");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener("open", r, { once: true });
  ws.addEventListener("error", j, { once: true });
});

function ev(expression) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6);
    const timer = setTimeout(() => reject(new Error("timeout")), 30000);
    ws.addEventListener("message", function onMsg(e) {
      const msg = JSON.parse(e.data);
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      resolve(msg.result?.result?.value);
    });
    ws.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });
}

const invoke = (cmd, args) =>
  `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args || {})})`;

console.log("config_list:", await ev(`(async () => JSON.stringify(await ${invoke("config_list")}))()`));
console.log(
  "cache:",
  await ev(`localStorage.getItem('tvbox:sites:v1')?.slice(0, 200) ?? 'none'`),
);
console.log(
  "spider home:",
  await ev(
    `(async () => { try { const r = await ${invoke("spider_invoke", {
      request: { siteKey: "stub_json", method: "homeContent", args: [] },
    })}; return 'OK:' + JSON.stringify(r).slice(0, 160); } catch (e) { return 'ERR:' + JSON.stringify(e); } })()`,
  ),
);
ws.close();
