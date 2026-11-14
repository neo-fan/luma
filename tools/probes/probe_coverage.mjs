#!/usr/bin/env node
/**
 * 真实配置分运行时覆盖率：哪些源能搜到、能出详情、能拿播放地址。
 *
 *   node tools/probes/probe_coverage.mjs
 *   LUMA_KEYWORD=走马上任 node tools/probes/probe_coverage.mjs
 */
const CONFIG =
  process.env.LUMA_CONFIG ||
  process.env.TVBOX_CONFIG ||
  "https://raw.githubusercontent.com/cluntop/tvbox/a08e4fe8f3e6c74ad8185f2ba3eef1a0c3d48bf8/box.json";
const KEYWORD = process.env.LUMA_KEYWORD || process.env.TVBOX_KEYWORD || "走马上任";

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      const slot = this.pending.get(msg.id);
      if (slot) {
        this.pending.delete(msg.id);
        slot(msg);
      }
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 120000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result;
  }
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) throw new Error(`eval failed: ${res.exceptionDetails.text}`);
    return res.result?.value;
  }
  close() {
    this.ws.close();
  }
}

async function main() {
  const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("no CDP page");
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready;
  const invoke = (cmd, args) =>
    cdp.eval(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);

  const snapshot = await invoke("config_import", { source: { kind: "url", value: CONFIG } });
  const sites = snapshot.sites || [];
  const runtimeOf = new Map(sites.map((s) => [s.key, s.runtime]));
  const nameOf = new Map(sites.map((s) => [s.key, s.name]));
  const totals = {};
  for (const site of sites) {
    totals[site.runtime] = (totals[site.runtime] || 0) + 1;
  }
  console.log("SITES:", JSON.stringify(totals));

  const started = Date.now();
  const agg = await invoke("spider_invoke", {
    request: { siteKey: "all", method: "searchContent", args: [KEYWORD, false, 1], timeoutMs: 25000 },
  });
  const took = Date.now() - started;

  const okByRuntime = {};
  const failByRuntime = {};
  const playable = [];
  for (const row of agg.results || []) {
    const runtime = runtimeOf.get(row.siteKey) || "?";
    if (row.ok) {
      okByRuntime[runtime] = (okByRuntime[runtime] || 0) + 1;
      for (const vod of row.data?.list || []) {
        playable.push({ siteKey: row.siteKey, runtime, name: nameOf.get(row.siteKey), vod });
      }
    } else {
      const code = row.error?.code || "?";
      failByRuntime[runtime] = failByRuntime[runtime] || {};
      failByRuntime[runtime][code] = (failByRuntime[runtime][code] || 0) + 1;
    }
  }

  console.log(`SEARCH: total=${agg.total} ok=${agg.ok} failed=${agg.failed} skipped=${agg.skipped} took=${took}ms hits=${playable.length}`);
  for (const runtime of Object.keys(totals).sort()) {
    console.log(
      `  ${runtime.padEnd(8)} total=${String(totals[runtime]).padStart(3)} responded=${String(okByRuntime[runtime] || 0).padStart(3)} failures=${JSON.stringify(failByRuntime[runtime] || {})}`,
    );
  }

  // 每个运行时挑一个有结果的站点，验证 detail → 播放地址。
  const detailReport = [];
  for (const runtime of Object.keys(totals).sort()) {
    const hit = playable.find((item) => item.runtime === runtime);
    if (!hit) {
      detailReport.push({ runtime, detail: "no search hit" });
      continue;
    }
    try {
      const rows = await invoke("spider_invoke", {
        request: {
          siteKey: hit.siteKey,
          method: "detailContent",
          args: [String(hit.vod.vod_id)],
          timeoutMs: 15000,
        },
      });
      const vod = Array.isArray(rows) ? rows[0] : null;
      const episodes = String(vod?.vod_play_url || "")
        .split("#")
        .filter(Boolean);
      const first = episodes[0] || "";
      const url = first.includes("$") ? first.slice(first.indexOf("$") + 1) : first;
      detailReport.push({
        runtime,
        site: hit.name,
        title: vod?.vod_name,
        episodes: episodes.length,
        firstUrl: url.slice(0, 90),
      });
    } catch (err) {
      detailReport.push({ runtime, site: hit.name, error: String(err).slice(0, 90) });
    }
  }
  console.log("DETAIL:");
  for (const row of detailReport) {
    console.log("  " + JSON.stringify(row));
  }

  cdp.close();
}

main().catch((err) => {
  console.error("PROBE FAILED:", err);
  process.exitCode = 1;
});
