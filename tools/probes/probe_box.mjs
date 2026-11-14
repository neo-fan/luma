/**
 * box.json 验证探针：导入配置 → 统计可用站点 → 全站搜索 → 打印每个源的成败。
 * 需要 dev 窗口（9222）在跑。网络请求全部由应用进程发出。
 */
const CONFIG = process.env.LUMA_CONFIG || process.env.TVBOX_CONFIG || "https://raw.githubusercontent.com/cluntop/tvbox/a08e4fe8f3e6c74ad8185f2ba3eef1a0c3d48bf8/box.json";
const KEYWORD = process.env.LUMA_KEYWORD || process.env.TVBOX_KEYWORD || "走马上任";

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) {
  console.error("no CDP page; start `pnpm tauri dev` with --remote-debugging-port=9222");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener("open", r, { once: true });
  ws.addEventListener("error", j, { once: true });
});
let id = 0;
const send = (method, params) =>
  new Promise((res) => {
    const my = ++id;
    const h = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== my) return;
      ws.removeEventListener("message", h);
      res(m.result);
    };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({ id: my, method, params }));
  });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) return `EVAL_ERR: ${r.exceptionDetails.text}`;
  return r?.result?.value;
};

const invoke = (cmd, args) => `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`;

const snapshot = await ev(`(async () => {
  try {
    const snap = await ${invoke("config_import", { source: { kind: "url", value: CONFIG } })};
    const counts = {};
    for (const s of snap.sites) counts[s.runtime] = (counts[s.runtime] || 0) + 1;
    return JSON.stringify({
      ok: true,
      id: snap.id,
      sites: snap.sites.length,
      lives: (snap.lives || []).length,
      runtimes: counts,
      py0: snap.sites.find((s) => s.runtime === "python")?.api || "",
      spider: snap.spider || "",
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: e && (e.code || e.message) });
  }
})()`);
console.log("import:", snapshot);

const started = Date.now();
const agg = await ev(`(async () => {
  try {
    const r = await ${invoke("spider_invoke", {
      request: { siteKey: "all", method: "searchContent", args: [KEYWORD, false, 1], timeoutMs: 20000 },
    })};
    const rows = (r.results || []).map((x) => ({
      site: x.siteKey,
      ok: !!x.ok,
      n: x.ok ? ((x.data && x.data.list) || []).length : 0,
      err: x.ok ? "" : String(x.error && (x.error.code || x.error.message) || "").slice(0, 48),
      first: x.ok ? (((x.data && x.data.list) || [])[0] || {}).vod_name || "" : "",
    }));
    return JSON.stringify({ total: rows.length, ok: rows.filter((x) => x.ok).length, rows });
  } catch (e) {
    return JSON.stringify({ fatal: String(e && (e.code || e.message)) });
  }
})()`);
console.log("search took", ((Date.now() - started) / 1000).toFixed(1) + "s");
const parsed = JSON.parse(agg);
if (parsed.rows) {
  const hits = parsed.rows.filter((r) => r.n > 0).sort((a, b) => b.n - a.n);
  console.log(
    `sources: ${parsed.ok}/${parsed.total} responded, ${hits.length} returned results, ${parsed.skipped ?? 0} skipped by budget`,
  );
  for (const r of hits.slice(0, 20)) console.log(`  ${r.site.padEnd(14)} ${String(r.n).padStart(3)}  ${r.first}`);
  const fails = parsed.rows.filter((r) => !r.ok);
  console.log(`failed: ${fails.length}`);
  for (const r of fails.slice(0, 12)) console.log(`  ${r.site.padEnd(14)} ${r.err}`);
} else {
  console.log("search:", agg);
}
ws.close();
