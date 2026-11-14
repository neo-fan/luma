#!/usr/bin/env node
/**
 * T-29 第 4 级嗅探验收：隐藏 WebView 加载桩播放页，必须抓到真实 m3u8。
 *
 * 断言：
 * 1) page 类地址经 resolve_play 返回 kind=hls 且 url 指向 m3u8；
 * 2) proxyUrl 已包成本地反代地址（带 Range/Referer 能力）；
 * 3) 第二次调用命中缓存，明显更快（不再新建窗口）；
 * 4) 没有媒体请求的页面在墙钟后降级回 page，不抛异常。
 *
 * 需要 dev 窗口（9222）、9978 反代、8787 桩服务。
 *   node tools/probes/probe_sniff.mjs
 */
import path from "node:path";
import { writeFileSync } from "node:fs";

const ROOT = process.cwd();
const STUB = "http://127.0.0.1:8787";
let passed = 0;
let failed = 0;
function check(ok, name, note = "") {
  if (ok) {
    passed += 1;
    console.log(`[ok  ] ${name}${note ? "  -- " + note : ""}`);
  } else {
    failed += 1;
    console.log(`[FAIL] ${name}${note ? "  -- " + note : ""}`);
  }
}

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
    if (res.exceptionDetails) {
      throw new Error(`eval failed: ${res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }
  async shot(name) {
    const res = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(ROOT, ".workbuddy", `${name}.png`), Buffer.from(res.data, "base64"));
  }
  close() {
    this.ws.close();
  }
}

async function main() {
  const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("no CDP page (is the dev window running?)");
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready;

  const resolve = (url) =>
    cdp.eval(`window.__TAURI_INTERNALS__.invoke('resolve_play', ${JSON.stringify({
      request: { siteKey: "sniff-probe", url },
    })})`);

  const started = Date.now();
  const first = await resolve(`${STUB}/page/play.html`);
  const firstMs = Date.now() - started;
  check(first?.kind === "hls", "page sniffed to hls", JSON.stringify({ kind: first?.kind, url: first?.url }));
  check(String(first?.url || "").includes("/media/index.m3u8"), "sniffed url is the playlist", String(first?.url));
  // 7.5.1 allows a dynamic port when 9978 is taken, so only the shape matters.
  check(/127\.0\.0\.1:\d+\/proxy\?/.test(String(first?.proxyUrl || "")),
    "proxy wrapped", String(first?.proxyUrl || "").slice(0, 90));

  const again = Date.now();
  const second = await resolve(`${STUB}/page/play.html`);
  const secondMs = Date.now() - again;
  check(second?.kind === "hls" && secondMs < Math.max(1500, firstMs / 2),
    "cached second resolve is fast", `${firstMs}ms -> ${secondMs}ms`);

  // A page with no media request must fall back to `page` instead of throwing.
  const emptyStart = Date.now();
  const empty = await resolve(`${STUB}/config.json`);
  const emptyMs = Date.now() - emptyStart;
  check(empty?.kind === "page", "no-media page falls back to page", `${empty?.kind} in ${emptyMs}ms`);
  check(emptyMs >= 14000, "fallback waited the 15s wall clock", `${emptyMs}ms`);

  await cdp.shot("sniff-1-result");
  cdp.close();
  console.log(`\nT-29 sniff summary: ${passed} pass / ${failed} fail`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error("PROBE FAILED:", err);
  process.exitCode = 1;
});
