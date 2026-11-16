#!/usr/bin/env node
/**
 * ArtPlayer 播放页回归：真实配置「搜索 → 详情 → 播放」出画 + 控件 + 历史。
 *
 * 与 probe_search_ui.mjs 的差别：这里不重新导入配置（沿用 SQLite 里的 active
 * 配置），强制 reload 后专门断言 ArtPlayer 容器、控件栏、清晰度插件、
 * 原生 <video> 解码出画，以及卸载前的进度写入。需要 dev 窗口（9222）。
 *
 *   node tools/probes/probe_artplayer.mjs
 *   LUMA_KEYWORD=走马上任 node tools/probes/probe_artplayer.mjs
 */
import { writeFileSync } from "node:fs";

const KEYWORD = process.env.LUMA_KEYWORD || "走马上任";

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Runtime.exceptionThrown") {
        const detail = msg.params?.exceptionDetails;
        this.errors.push(detail?.exception?.description || detail?.text || "unknown exception");
        return;
      }
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

async function waitForPage(timeoutMs = 30000) {
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
await cdp.send("Page.reload", { ignoreCache: true });
const boot = await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000));
assert(boot === "OK", "page reloaded with latest bundle", String(boot));

// 1. 真实配置全站搜索（沿用 SQLite active 配置，不重复导入）。
assert((await cdp.eval(CLICK("搜索", ".nav__item"))) === "CLICKED", "open search page");
// 搜索页是 lazy 路由：点导航后 React 才异步挂出 .search-bar，CLICKED 立刻读
// DOM 会拿到 MISSING（旧版从「select all sites」起整串假失败就是这个）。先等搜索栏
// 真的挂上再操作（与已修好的 probe_search_ui 同一口径，只是这里 reload 后是冷块）。
const searchMounted = await cdp.eval(
  WAIT("return document.querySelector('.search-bar input.input') ? 'OK' : null;", 20000),
);
assert(searchMounted === "OK", "search page mounted", String(searchMounted));
assert((await cdp.eval(SELECT(".search-bar select", "__all__"))) === "__all__", "select all sites");
assert((await cdp.eval(TYPE(".search-bar input.input", KEYWORD))) === "TYPED", "type keyword");
assert((await cdp.eval(CLICK("搜索", ".search-bar button"))) === "CLICKED", "submit search");
const meta = await cdp.eval(
  WAIT(
    "const el = document.querySelector('.result-meta'); return el && !document.querySelector('.spinner') ? el.innerText : null;",
    60000,
  ),
);
assert(!!meta, "aggregate search finished", String(meta));
const cards = Number(await cdp.eval(`document.querySelectorAll('.vod-card').length`));
assert(cards > 0, "search cards rendered", `${cards} cards`);

// 2. 详情 → 播放。
const opened = await cdp.eval(`(() => {
  const nodes = [...document.querySelectorAll('.vod-card')];
  if (!nodes.length) return 'MISSING';
  const card = nodes.find((c) => /创享|速播|非凡|艾旦|金鹰|量子|暴風|暴风/.test(c.innerText)) || nodes[0];
  card.click();
  return card.innerText.split('\\n')[0];
})()`);
assert(opened !== "MISSING", "open first result", String(opened));
const detail = await cdp.eval(
  WAIT("return document.body.innerText.includes('播放线路') ? 'OK' : null;", 30000),
);
assert(detail === "OK", "detail page rendered", String(detail));
const episodeClicked = await cdp.eval(`(() => {
  const el = document.querySelector('.content .episode');
  if (!el) return 'MISSING';
  el.click();
  return 'CLICKED';
})()`);
assert(episodeClicked === "CLICKED", "click episode", episodeClicked);

// 3. ArtPlayer 挂载 + 真实解码出画。真实源首条线路常是分享页，遇到不可播
// 地址就顺着「下一集」继续找，避免把源质量问题误判成播放器故障。
// ArtPlayer 把 .art-video-player / .artplayer-app 模板插进容器内部，
// 容器本身只带 data-art-id，所以按「容器内有 video + 控件栏」判断挂载。
const MOUNTED = `
  const host = document.querySelector('.player-art');
  return host && host.querySelector('video') && host.querySelector('.art-controls')
    ? host.className : null;
`;
let mounted = null;
let attempts = 0;
for (let attempt = 0; attempt < 6 && !mounted; attempt += 1) {
  attempts = attempt + 1;
  if (attempt > 0) {
    const next = await cdp.eval(`(() => {
      const b = document.querySelector('.art-control-next-episode[aria-label="下一集"]');
      if (!b || b.getAttribute('aria-disabled') === 'true') return 'MISSING';
      b.click();
      return 'CLICKED';
    })()`);
    if (next !== "CLICKED") {
      console.log(`[info] no more episodes after ${attempt} attempt(s)`);
      break;
    }
  }
  mounted = await cdp.eval(WAIT(MOUNTED, 22000));
}
console.log(`[info] playable line found after ${attempts} attempt(s)`);
assert(!!mounted, "ArtPlayer mounted in page", String(mounted));
if (!mounted) {
  console.log(`[diag] page text: ${String(await cdp.eval(`document.body.innerText.slice(0, 600)`))}`);
  console.log(`[diag] exceptions: ${cdp.errors.slice(0, 5).join(" | ").slice(0, 1200)}`);
}

// 真实源里死链很常见：ArtPlayer 挂载成功但 hls.js 报 manifestLoadError。
// 保持「必须真实解码出画」的断言强度，但给多条线路机会，避免把某个源站
// 的临时故障误判成播放器退化。每轮都重新确认挂载，因为换集会重建实例。
const PLAYING_EXPR = `
  const v = document.querySelector('.player-art video');
  return v && v.readyState >= 2 && v.videoWidth > 0
    ? JSON.stringify({ w: v.videoWidth, h: v.videoHeight, t: v.currentTime, paused: v.paused })
    : null;
`;
let playing = null;
let lineAttempts = 0;
for (let attempt = 0; attempt < 6 && mounted && !playing; attempt += 1) {
  lineAttempts = attempt + 1;
  if (attempt > 0) {
    const next = await cdp.eval(`(() => {
      const b = document.querySelector('.art-control-next-episode[aria-label="下一集"]');
      if (!b || b.getAttribute('aria-disabled') === 'true') return 'MISSING';
      b.click();
      return 'CLICKED';
    })()`);
    if (next !== "CLICKED") {
      console.log(`[info] no more episodes after ${attempt} line attempt(s)`);
      break;
    }
    mounted = await cdp.eval(WAIT(MOUNTED, 22000));
    if (!mounted) {
      console.log(`[info] ArtPlayer not remounted on attempt ${lineAttempts}`);
      break;
    }
  }
  playing = await cdp.eval(WAIT(PLAYING_EXPR, 20000));
  if (!playing) {
    const reason = await cdp.eval(`document.querySelector('.error-bar')?.innerText || 'no frames in 20s'`);
    console.log(`[info] line ${lineAttempts} not playable: ${String(reason).slice(0, 120)}`);
  }
}
console.log(`[info] real frames after ${lineAttempts} line attempt(s)`);
assert(!!playing, "video decoded real frames", String(playing));

const controls = await cdp.eval(`(() => {
  const bar = document.querySelector('.player-art .art-controls');
  if (!bar) return null;
  const items = [...bar.querySelectorAll('.art-control')].map((el) => ({
    name: el.className, text: (el.innerText || '').trim().slice(0, 20),
  }));
  return JSON.stringify({ count: items.length, items: items.slice(0, 20) });
})()`);
const parsed = controls ? JSON.parse(controls) : null;
assert(!!parsed && parsed.count >= 6, "control bar rendered", `${parsed?.count ?? 0} controls`);
const quality = await cdp.eval(`(() => {
  const bar = document.querySelector('.player-art .art-controls');
  if (!bar) return null;
  const named = [...bar.querySelectorAll('[class*=quality],[class*=hls]')].map((el) => el.className);
  return JSON.stringify({ text: (bar.innerText || '').slice(0, 200), named });
})()`);
const qualityInfo = quality ? JSON.parse(quality) : null;
// 单码率源按设计回退到码率/原画，不会出现清晰度切换控件；只有多码率
// （文本里含 720P / 1080P 等）才要求插件把控件渲染出来。
const multiBitrate = !!qualityInfo && /\d{3,4}P/.test(qualityInfo.text);
if (multiBitrate) {
  assert(
    qualityInfo.named.some((name) => name.includes("art-control-hls-quality")),
    "HLS quality control present",
    JSON.stringify(qualityInfo),
  );
} else {
  console.log(`[n-a ] HLS quality control skipped (single-bitrate source): ${JSON.stringify(qualityInfo)}`);
}
assert(
  !!qualityInfo && !/\b0P\b/.test(qualityInfo.text),
  "quality label falls back instead of 0P",
  JSON.stringify(qualityInfo?.text),
);

// 4. 历史进度：只在真的播起来之后检查，等过 5 秒节流窗口再读 SQLite。
if (mounted && playing) {
  await new Promise((r) => setTimeout(r, 6500));
  const history = await cdp.eval(`(async () => {
    try {
      const items = await window.__TAURI_INTERNALS__.invoke('history_list');
      return JSON.stringify(items.slice(0, 3));
    } catch (e) { return 'ERR:' + String(e); }
  })()`);
  const records = typeof history === "string" && history.startsWith("[") ? JSON.parse(history) : [];
  assert(records.length > 0, "history upsert written", String(history).slice(0, 200));
  assert(
    records.some((r) => Number(r.positionMs) > 0),
    "history kept playback position",
    JSON.stringify(records.map((r) => r.positionMs)),
  );
} else {
  console.log("[n-a ] history check skipped: no playable line");
}

assert(cdp.errors.length === 0, "no uncaught page exceptions", cdp.errors.slice(0, 3).join(" | ").slice(0, 600));
await cdp.shot("artplayer-player");

cdp.close();
console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed step(s)`);
process.exit(failures === 0 ? 0 : 1);
