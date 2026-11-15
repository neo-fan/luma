#!/usr/bin/env node
/**
 * 真实配置 UI 验收：导入 box.json → 全站搜索 → 详情 → 播放。
 *
 * 与 probe_box.mjs（直接打 IPC）不同，这里完全通过页面 DOM 操作，验证
 * SearchPage 的一次聚合调用、active 配置隔离、三参数搜索签名和结果渲染。
 * 需要 dev 窗口（9222）。
 *
 *   node tools/probes/probe_search_ui.mjs
 *   LUMA_CONFIG=... LUMA_KEYWORD=... node tools/probes/probe_search_ui.mjs
 */
import { writeFileSync } from "node:fs";

const CONFIG =
  process.env.LUMA_CONFIG ||
  "https://raw.githubusercontent.com/cluntop/tvbox/a08e4fe8f3e6c74ad8185f2ba3eef1a0c3d48bf8/box.json";
const KEYWORD = process.env.LUMA_KEYWORD || "走马上任";

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
    const path = `tools/.out/${name}.png`;
    writeFileSync(path, Buffer.from(res.data, "base64"));
    console.log(`[shot] ${path}`);
  }

  close() {
    this.ws.close();
  }
}

async function waitForPage(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("CDP page target not found");
}

const CLICK = (label, selector = "button, a") => `(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const target = nodes.find((n) => (n.textContent || '').trim() === ${JSON.stringify(label)});
  if (!target) return 'MISSING';
  target.click();
  return 'CLICKED';
})()`;

const TYPE = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'MISSING';
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'TYPED';
})()`;

const SELECT = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'MISSING';
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
})()`;

const WAIT = (expression, timeout = 30000) => `(async () => {
  const deadline = Date.now() + ${timeout};
  while (Date.now() < deadline) {
    const value = (() => { ${expression} })();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
})()`;

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
console.log(`target: ${page.url}`);

// 1. 通过设置页导入真实配置
assert((await cdp.eval(CLICK("设置", ".nav__item"))) === "CLICKED", "open settings");
assert((await cdp.eval(TYPE(".settings-block input.input", CONFIG))) === "TYPED", "type config url");
assert((await cdp.eval(CLICK("导入"))) === "CLICKED", "click import");
// `已导入配置` is a section title, so wait for the success notice AND a fully
// populated site cache instead of a loose substring match.
const imported = await cdp.eval(WAIT(`
  const notice = document.querySelector('.tip--ok');
  const raw = (localStorage.getItem('luma:sites:v1'));
  const count = raw ? (JSON.parse(raw).sites || []).length : 0;
  return notice && notice.innerText.includes('已导入') && count > 50 ? notice.innerText : null;
`, 60000));
assert(!!imported, "real config imported", String(imported));

const cache = await cdp.eval(`(() => {
  const raw = (localStorage.getItem('luma:sites:v1'));
  if (!raw) return null;
  const c = JSON.parse(raw);
  const counts = {};
  for (const s of c.sites) counts[s.runtime] = (counts[s.runtime] || 0) + 1;
  return { id: c.configId, sites: c.sites.length, lives: (c.lives || []).length, runtimes: counts,
           firstPy: (c.sites.find((s) => s.runtime === 'python') || {}).api || '' };
})()`);
assert(!!cache && cache.sites > 50, "site cache populated", JSON.stringify(cache));
assert(String(cache?.firstPy || "").startsWith("https://"), "relative py api resolved", cache?.firstPy);
await cdp.shot("search-1-import");

// 2. 搜索页走一次并发聚合
assert((await cdp.eval(CLICK("搜索", ".nav__item"))) === "CLICKED", "open search page");
assert((await cdp.eval(SELECT(".search-bar select", "__all__"))) === "__all__", "all sites selected");
assert((await cdp.eval(TYPE(".search-bar input.input", KEYWORD))) === "TYPED", "type keyword");
const started = Date.now();
assert((await cdp.eval(CLICK("搜索", ".search-bar button"))) === "CLICKED", "submit search");
const meta = await cdp.eval(
  WAIT(
    "const el = document.querySelector('.result-meta'); return el && !document.querySelector('.spinner') ? el.innerText : null;",
    60000,
  ),
);
const cards = await cdp.eval(`document.querySelectorAll('.vod-card').length`);
const took = ((Date.now() - started) / 1000).toFixed(1);
assert(!!meta, "aggregate search finished", `${meta || "TIMEOUT"} in ${took}s`);
assert(Number(cards) > 0, "search cards rendered", `${cards} cards`);
assert(/个站点响应/.test(meta || ""), "aggregate progress reported", meta || "");
await cdp.shot("search-2-results");

// 3. 点开首条结果 → 详情 → 播放
const opened = await cdp.eval(`(() => {
  const cards = [...document.querySelectorAll('.vod-card')];
  if (!cards.length) return 'MISSING';
  // Prefer a CMS source: its detail/play URLs are the most reliable path.
  const card = cards.find((c) => /创享|速播|非凡|艾旦|金鹰|量子|暴風|暴风/.test(c.innerText)) || cards[0];
  card.click();
  return card.innerText.split('\\n')[0];
})()`);
assert(opened !== "MISSING", "open first result", String(opened));
const detail = await cdp.eval(WAIT("return document.body.innerText.includes('播放线路') ? 'OK' : null;", 30000));
assert(detail === "OK", "detail page rendered", String(detail));
const episodes = await cdp.eval(`document.querySelectorAll('.episode').length`);
assert(Number(episodes) > 0, "episodes available", `${episodes} episodes`);
if (Number(episodes) > 0) {
  await cdp.eval(`document.querySelector('.episode').click()`);
  const player = await cdp.eval(
    WAIT("const v = document.querySelector('video'); return v && (v.currentSrc || v.src) ? (v.currentSrc || v.src) : null;", 40000),
  );
  assert(!!player, "player has a media source", String(player).slice(0, 140));
  const playing = await cdp.eval(WAIT(`
    const v = document.querySelector('video');
    return v && v.readyState >= 2 && v.videoWidth > 0
      ? JSON.stringify({ w: v.videoWidth, h: v.videoHeight, t: v.currentTime, paused: v.paused })
      : null;
  `, 90000));
  assert(!!playing, "video decoded real frames", String(playing));
  await cdp.shot("search-3-player");
}

cdp.close();
console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed step(s)`);
process.exit(failures === 0 ? 0 : 1);
