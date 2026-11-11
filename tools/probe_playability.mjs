#!/usr/bin/env node
/**
 * 播放可达性采样：对每个运行时取若干真实搜索结果，走 detail → resolve_play，
 * 判断首集地址是直链、分享页（可嗅探）还是网盘解析串（不支持）。
 *
 *   node tools/probe_playability.mjs
 */
const CONFIG =
  process.env.LUMA_CONFIG ||
  process.env.TVBOX_CONFIG ||
  "https://raw.githubusercontent.com/cluntop/tvbox/a08e4fe8f3e6c74ad8185f2ba3eef1a0c3d48bf8/box.json";
const KEYWORD = process.env.LUMA_KEYWORD || process.env.TVBOX_KEYWORD || "庆余年";
const SAMPLE = Number(process.env.LUMA_SAMPLE || process.env.TVBOX_SAMPLE || "3");

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

function classifyUrl(url) {
  const lower = String(url).toLowerCase();
  if (!/^https?:\/\//.test(lower)) return "not-http";
  if (lower.includes(".m3u8")) return "direct-hls";
  if (/\.(mp4|flv|mkv|mov|webm)(\?|#|$)/.test(lower)) return "direct-file";
  return "page-or-share";
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

  const agg = await invoke("spider_invoke", {
    request: { siteKey: "all", method: "searchContent", args: [KEYWORD, false, 1], timeoutMs: 25000 },
  });

  // 每个运行时收集有结果的站点，最多 SAMPLE 个。
  const buckets = new Map();
  for (const row of agg.results || []) {
    if (!row.ok) continue;
    const runtime = runtimeOf.get(row.siteKey) || "?";
    const first = (row.data?.list || [])[0];
    if (!first) continue;
    const list = buckets.get(runtime) || [];
    if (list.length < SAMPLE) list.push({ siteKey: row.siteKey, vod: first });
    buckets.set(runtime, list);
  }

  const summary = {};
  for (const runtime of ["cms", "python", "quickjs", "jvm"]) {
    const picks = buckets.get(runtime) || [];
    if (picks.length === 0) {
      summary[runtime] = { sampled: 0, note: "no search hits" };
      continue;
    }
    const rows = [];
    for (const pick of picks) {
      const entry = { site: nameOf.get(pick.siteKey), title: pick.vod.vod_name };
      try {
        const detail = await invoke("spider_invoke", {
          request: {
            siteKey: pick.siteKey,
            method: "detailContent",
            args: [String(pick.vod.vod_id)],
            timeoutMs: 15000,
          },
        });
        const vod = Array.isArray(detail) ? detail[0] : null;
        // 一条剧常有多个线路（`$$$` 分隔），只看第一条会低估可播性。
        const lines = String(vod?.vod_play_url || "").split("$$$").filter(Boolean);
        const kinds = { "direct-hls": 0, "direct-file": 0, "page-or-share": 0, "not-http": 0 };
        let episodes = 0;
        let firstHttp = "";
        for (const line of lines) {
          for (const episode of line.split("#").filter(Boolean)) {
            const url = episode.includes("$") ? episode.slice(episode.indexOf("$") + 1) : episode;
            const kind = classifyUrl(url);
            kinds[kind] += 1;
            episodes += 1;
            if (!firstHttp && /^https?:\/\//.test(url) && kind !== "page-or-share") {
              firstHttp = url;
            }
          }
        }
        entry.episodes = episodes;
        entry.lines = lines.length;
        entry.kinds = kinds;
        entry.playable = kinds["direct-hls"] + kinds["direct-file"];
        const probeUrl = firstHttp || "";
        if (probeUrl) {
          entry.url = probeUrl.slice(0, 70);
          try {
            const resolved = await invoke("resolve_play", {
              request: { siteKey: pick.siteKey, url: probeUrl },
            });
            entry.resolvedKind = resolved?.kind;
            entry.proxied = Boolean(resolved?.proxyUrl);
          } catch (err) {
            entry.resolveError = String(err).slice(0, 80);
          }
        }
      } catch (err) {
        entry.error = String(err).slice(0, 80);
      }
      rows.push(entry);
    }
    summary[runtime] = { sampled: rows.length, rows };
  }

  console.log(JSON.stringify(summary, null, 2));
  cdp.close();
}

main().catch((err) => {
  console.error("PROBE FAILED:", err);
  process.exitCode = 1;
});
