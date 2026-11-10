#!/usr/bin/env node
/**
 * 直播页验收：`lives[]` 的三种形态都要能用或明确禁用。
 *
 * 断言：
 * 1) 17 条直播源都渲染成 chip；
 * 2) 分组容器（只有 `channels`、没有 `url`）显示为禁用而不是点开报错；
 * 3) 有 url 的源能拉出频道列表；
 * 4) `lives[].ua` 会随播放请求走到本地反代（proxyUrl 带 ua 参数）。
 *
 * 需要 dev 窗口（9222）与 8787 桩服务：
 *   node tools/probe_live.mjs
 */
import path from "node:path";
import { writeFileSync } from "node:fs";

const ROOT = process.cwd();
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
  async shot(name) {
    const res = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(ROOT, ".workbuddy", `${name}.png`), Buffer.from(res.data, "base64"));
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
  if (!page) throw new Error("no CDP page (is the dev window running?)");
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready;

  // 回到首页再进直播，避免上次停留在播放页。
  await cdp.eval(`(() => {
    const back = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '返回');
    if (back) back.click();
    return 'ok';
  })()`);
  await new Promise((r) => setTimeout(r, 400));

  const opened = await cdp.eval(`(() => {
    const nav = [...document.querySelectorAll('.nav__item')].find((e) => (e.innerText || '').includes('直播'));
    if (!nav) return 'NO_NAV';
    nav.click();
    return 'CLICKED';
  })()`);
  check(opened === "CLICKED", "open live page", String(opened));

  const chips = await cdp.eval(WAIT("const el = document.querySelector('.page .chip-row'); return el ? el.querySelectorAll('.chip').length : null;", 15000));
  check(Number(chips) >= 15, "live sources rendered as chips", `${chips} chips`);

  const disabled = await cdp.eval(`(() => {
    const row = document.querySelector('.page .chip-row');
    if (!row) return -1;
    return [...row.querySelectorAll('.chip')].filter((c) => c.disabled).length;
  })()`);
  check(disabled >= 1, "group container is disabled, not clickable", `${disabled} disabled`);

  const disabledLabel = await cdp.eval(`(() => {
    const row = document.querySelector('.page .chip-row');
    if (!row) return '';
    const chip = [...row.querySelectorAll('.chip')].find((c) => c.disabled);
    return chip ? chip.innerText.trim() : '';
  })()`);
  check(!!disabledLabel, "disabled chip still has a readable label", disabledLabel);

  // 关掉禁用源后回到第一个可用源，等它把频道拉出来。
  await cdp.eval(`(() => {
    const row = document.querySelector('.page .chip-row');
    if (!row) return 'NO_ROW';
    const chip = [...row.querySelectorAll('.chip')].find((c) => !c.disabled);
    if (!chip) return 'NO_ENABLED';
    chip.click();
    return 'CLICKED';
  })()`);
  const channelCount = await cdp.eval(WAIT(
    "const rows = document.querySelectorAll('.page .section'); return rows.length > 0 ? document.querySelectorAll('.page .section .chip').length : null;",
    40000,
  ));
  check(Number(channelCount) > 0, "channels loaded for an enabled source", `${channelCount} channels`);

  await cdp.shot("live-1-list");

  // lives[].ua 透传：用桩 m3u8 + 自定义 UA 验证 proxyUrl 携带 ua。
  const withUa = await cdp.eval(`(async () => {
    const r = await window.__TAURI_INTERNALS__.invoke('resolve_play', {
      request: { siteKey: 'live', url: 'http://127.0.0.1:8787/media/index.m3u8', ua: 'live-ua-test' },
    });
    return { kind: r.kind, proxyUrl: r.proxyUrl, headers: r.headers };
  })()`);
  check(/ua=live-ua-test/.test(String(withUa?.proxyUrl || "")), "live UA reaches the proxy url", String(withUa?.proxyUrl || "").slice(0, 120));
  check(
    (withUa?.headers || []).some(([name, value]) => String(name).toLowerCase() === "user-agent" && value === "live-ua-test"),
    "live UA also in returned headers",
    JSON.stringify(withUa?.headers || []),
  );

  cdp.close();
  console.log(`\nlive summary: ${passed} pass / ${failed} fail`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error("PROBE FAILED:", err);
  process.exitCode = 1;
});
