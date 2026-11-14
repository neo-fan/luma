#!/usr/bin/env node
/**
 * py 源播放验证：搜索 → 点一个 `[py]` 源的结果 → 详情 → 第一集 → 检查出画。
 * 这是 playerContent 接入后的关键回归（修复前 py 源只有分享页/自定义 scheme）。
 *
 *   node tools/probes/probe_py_play.mjs
 */
const CONFIG =
  process.env.LUMA_CONFIG ||
  process.env.TVBOX_CONFIG ||
  "https://raw.githubusercontent.com/cluntop/tvbox/a08e4fe8f3e6c74ad8185f2ba3eef1a0c3d48bf8/box.json";
const KEYWORD = process.env.LUMA_KEYWORD || process.env.TVBOX_KEYWORD || "走马上任";

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
    if (res.exceptionDetails) throw new Error(`eval failed: ${res.exceptionDetails.text}`);
    return res.result?.value;
  }
  close() {
    this.ws.close();
  }
}

const WAIT = (expression, timeout = 30000) => `(async () => {
  const deadline = Date.now() + ${timeout};
  while (Date.now() < deadline) {
    const value = (() => { ${expression} })();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
})()`;

async function main() {
  const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("no CDP page");
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready;
  const invoke = (cmd, args) =>
    cdp.eval(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);

  await invoke("config_import", { source: { kind: "url", value: CONFIG } });
  await invoke("config_list");

  // 先重载首页，避免停在上一轮的播放页导致导航栏不存在。
  await cdp.send("Page.navigate", { url: "http://localhost:1420/" });
  await new Promise((r) => setTimeout(r, 3000));
  await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('.nav__item')].find((e) => (e.innerText || '').includes('搜索'));
    if (el) el.click();
    return 'ok';
  })()`);
  const ready = await cdp.eval(WAIT("return document.querySelector('.search-bar input.input') ? 'READY' : null;", 10000));
  check(ready === "READY", "search page ready", String(ready));
  await cdp.eval(`(() => {
    const input = document.querySelector('.search-bar input.input');
    if (!input) return 'MISSING';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(KEYWORD)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('button.btn')].find((b) => (b.innerText || '').includes('搜索'));
    if (btn) btn.click();
    return 'SUBMITTED';
  })()`);

  const count = await cdp.eval(WAIT("return document.querySelectorAll('.vod-card').length;", 45000));
  check(Number(count) > 0, "search returned cards", `${count} cards`);

  // 找一个 py 源的卡片（卡片 sub 行显示站点名，含 [py]）
  const siteHint = process.env.LUMA_SITE || process.env.TVBOX_SITE || "[py]";
  const picked = await cdp.eval(`(() => {
    const cards = [...document.querySelectorAll('.vod-card')];
    const target = cards.find((c) => (c.innerText || '').includes(${JSON.stringify(siteHint)}));
    if (!target) return null;
    const lines = (target.innerText || '').split('\\n').filter(Boolean);
    target.click();
    return JSON.stringify({ title: lines[0] || '', sub: lines[lines.length - 1] || '' });
  })()`);
  check(!!picked, "found a py-source card", String(picked).slice(0, 120));
  if (!picked) {
    cdp.close();
    console.log(`\npy play summary: ${passed} pass / ${failed} fail`);
    process.exitCode = 1;
    return;
  }

  const detailOk = await cdp.eval(WAIT("return document.querySelector('.episode') ? 'OK' : null;", 30000));
  check(detailOk === "OK", "detail page with episodes");

  await cdp.eval(`(() => {
    const ep = document.querySelector('.episode');
    if (ep) ep.click();
    return ep ? 'CLICKED' : 'MISSING';
  })()`);

  const playerState = await cdp.eval(WAIT(
    `const v = document.querySelector('video');
     return v && v.readyState >= 2 && v.videoWidth > 0
       ? JSON.stringify({ w: v.videoWidth, h: v.videoHeight, t: v.currentTime, paused: v.paused, src: (v.currentSrc || '').slice(0, 50) })
       : null;`,
    45000,
  ));
  check(!!playerState, "py source decoded real frames", String(playerState));

  const banner = await cdp.eval(`(() => {
    const el = document.querySelector('.error-bar');
    return el ? el.innerText : '';
  })()`);
  check(!banner, "no error banner", String(banner).slice(0, 120));

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const fs = await import("node:fs");
  fs.writeFileSync(".workbuddy/py-play.png", Buffer.from(shot.data, "base64"));

  cdp.close();
  console.log(`\npy play summary: ${passed} pass / ${failed} fail`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error("PROBE FAILED:", err);
  process.exitCode = 1;
});
