#!/usr/bin/env node
/**
 * Rust 分层后 command 连通性冒烟。
 *
 * 背景：`src-tauri/src/{infra,domain}/` 用 `#[path]` 物理归档，逻辑模块名与
 * `generate_handler!` 的 command 路径保持原样。`cargo check`/`cargo test` 抓不出
 * `generate_handler!` 里 command 名写错导致的运行时 "command not found"——本探针
 * 通过真实 WebView2 逐个调用只读 command 补上这层验证，只读、无副作用、可重复跑。
 *
 * 覆盖跨层模块：config/spider/proxy(domain) + store/logging/clipboard(infra)。
 */
const CDP = "http://127.0.0.1:9222/json/list";
const list = await (await fetch(CDP)).json();
const page = list.find(
  (t) => t.type === "page" && t.webSocketDebuggerUrl && t.url.startsWith("http://localhost:1420"),
);
if (!page) throw new Error("no luma CDP page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener("open", r, { once: true });
  ws.addEventListener("error", j, { once: true });
});

function ev(expression) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6);
    const timer = setTimeout(() => reject(new Error("evaluate timeout")), 30000);
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

// 每个 command 用「无副作用」的参数调用：只读项直接取结果；写入/外部调用项
// 传空参数，预期得到参数校验错误——但只要不是 "command not found" 就证明已注册。
// 覆盖全部 11 个含 command 的源文件、跨 infra/ 与 domain/ 两个分层。
const COMMANDS = [
  ["config_list", {}],        // domain::config（只读）
  ["config_active", {}],      // domain::config（只读）
  ["proxy_status", {}],       // domain::proxy（只读）
  ["spider_invoke", {}],      // domain::spider（空参数预期 err）
  ["parse_resolve", {}],      // domain::parse（空参数预期 err）
  ["resolve_play", {}],       // domain::play（空参数预期 err）
  ["live_parse", {}],         // domain::live（空参数预期 err）
  ["mpv_play", {}],           // domain::mpv（空参数预期 err，不会真起 mpv）
  ["http_fetch", {}],         // infra::http（空参数预期 err）
  ["history_list", {}],       // infra::store（只读）
  ["favorites_list", {}],     // infra::store（只读）
  ["diagnostics", {}],        // infra::logging（只读）
  ["copy_text", {}],          // domain::clipboard（空参数预期 err）
];

// 等 App 挂载（invoke handler 在运行期就绪）。
let ready = null;
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  ready = await ev(`document.querySelector('.nav__item') ? 'OK' : null`);
  if (ready === "OK") break;
  await new Promise((r) => setTimeout(r, 500));
}
if (ready !== "OK") throw new Error("app did not render; cannot smoke commands");
console.log(`target: ${page.url}\n`);

let ok = 0;
for (const [name, args] of COMMANDS) {
  const raw = await ev(
    `(async () => {
      try {
        const out = await ${invoke(name, args)};
        return JSON.stringify({ ok: true, type: typeof out, sample: JSON.stringify(out).slice(0, 100) });
      } catch (e) {
        return JSON.stringify({ ok: false, err: String((e && e.message) || e) });
      }
    })()`,
  );
  let res;
  try {
    res = JSON.parse(raw);
  } catch {
    throw new Error(`${name}: non-JSON reply: ${String(raw).slice(0, 200)}`);
  }
  const notFound = /command not found|no command|unknown command/i.test(res.err || "");
  if (notFound) {
    throw new Error(`${name}: COMMAND NOT FOUND — 检查 generate_handler! 路径（分层后 command 丢失）`);
  }
  // 参数不匹配的 command 会 err，但只要不是 "not found" 就证明已注册可达。
  if (res.ok) {
    console.log(`[ok  ] ${name} -> ${res.type} ${res.sample}`);
    ok += 1;
  } else {
    console.log(`[ok* ] ${name} -> 已注册（参数预期报错：${res.err.slice(0, 60)}）`);
    ok += 1;
  }
}

ws.close();
console.log(`\nPASS: ${ok}/${COMMANDS.length} commands reachable across infra/ + domain/`);
