#!/usr/bin/env node
/**
 * 首页站点记忆 + 默认空站自动顺延回归。
 *
 * 覆盖三件事（只读 + 只动 localStorage，不改后端配置、不导入配置）：
 *   1. 手动切站后 reload 仍停在该站（记住用户切换的首页）且有卡片；
 *   2. 清掉偏好模拟冷启动默认空站（豆瓣只给分类），自动顺延到有内容的站并记住；
 *   3. 用户手动切到空站后 reload 不被自动跳走（尊重用户选择）。
 *
 * 前置：dev 窗口在跑（CDP 9222）、active 配置含至少一个首页有 list 的站
 * （真实 box 配置的「直播[py]」有 63 条）。不依赖外网：探测走 dev 已加载的
 * 站点缓存，homeContent 由后端 + 桩/真实源解析，慢站有超时兜底。
 */
const HOME_SITE_KEY = "luma:home:site:v1";
const CDP = "http://127.0.0.1:9222/json/list";

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
        const d = msg.params?.exceptionDetails;
        this.errors.push(d?.exception?.description || d?.text || "unknown");
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
    if (res.exceptionDetails) throw new Error(`eval failed: ${res.exceptionDetails.text}`);
    return res.result?.value;
  }
  close() {
    this.ws.close();
  }
}

const WAIT = (expression, timeout = 20000) => `(async () => {
  const deadline = Date.now() + ${timeout};
  while (Date.now() < deadline) {
    const v = (() => { ${expression} })();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
})()`;

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPage() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(CDP)).json();
      const page = list.find((t) => t.type === "page" && t.url.startsWith("http://localhost:1420"));
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error("no luma CDP page");
}

/** 清偏好 + reload，并稳定等待首页渲染。 */
async function coldStart(cdp) {
  await cdp.eval(`localStorage.removeItem(${JSON.stringify(HOME_SITE_KEY)})`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  await cdp.eval(WAIT("return document.querySelector('select.select') ? 'OK' : null;", 30000));
}

/** 用真实 change 事件切站。 */
async function selectSite(cdp, key) {
  return cdp.eval(`(() => {
    const s = document.querySelector('select.select');
    if (!s) return 'NO_SELECT';
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(s, ${JSON.stringify(key)});
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return 'OK';
  })()`);
}

const snapshot = (cdp) =>
  cdp.eval(`JSON.stringify({
    selected: document.querySelector('select.select')?.value || null,
    cards: document.querySelectorAll('.vod-card').length,
    stored: localStorage.getItem(${JSON.stringify(HOME_SITE_KEY)}),
    empty: !!document.querySelector('.empty'),
  })`);

/** 找到一个首页有 list 的站（探测前 12 个启用站，取其 key）。 */
async function findDataSite(cdp) {
  const raw = await cdp.eval(`(async () => {
    const snap = await window.__TAURI_INTERNALS__.invoke('config_active');
    const sites = (snap?.sites||[]).filter(s => s.enabled !== false && s.api && s.runtime !== 'jvm' && s.runtime !== 'quickjs');
    for (const s of sites.slice(0, 12)) {
      try {
        const r = await Promise.race([
          window.__TAURI_INTERNALS__.invoke('spider_invoke', {request:{siteKey:s.key,method:'homeContent',args:[]}}),
          new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),8000)),
        ]);
        if ((r?.list||[]).length > 0) return JSON.stringify({key:s.key,count:(r.list||[]).length});
      } catch { /* next */ }
    }
    return JSON.stringify({key:null});
  })()`);
  return JSON.parse(raw || "{}");
}

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
console.log(`target: ${page.url}\n`);
let dataSiteKey = null;
let originalStored = null;

try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

  // 关键：先强制 reload 让 WebView2 载入最新模块，再做自检。
  // 只 setCacheDisabled 不够——窗口里可能仍跑着改代码前的旧 App.tsx
  // （有 usableHomeSites 调用却没有该 import），会报 ReferenceError 而
  // 源码自检却因 dev server 已是新代码而误判为「fresh」。曾因此整轮误报。
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000));

  // dev server 源码新鲜度自检：确认探针跑的是含自动顺延逻辑的新代码。
  const src = await fetch(
    `http://localhost:1420/src/pages/HomePage.tsx?probe=${Date.now()}`,
  )
    .then((r) => r.text())
    .catch(() => "");
  const fresh = src.includes("findHomeSiteWithList") && src.includes("isDefaultSite");
  assert(fresh, "dev server serves fresh HomePage (auto-fallback)", fresh ? "" : "stale Vite module; restart dev");
  if (!fresh) throw new Error("stale dev module; abort");

  originalStored = await cdp.eval(`localStorage.getItem(${JSON.stringify(HOME_SITE_KEY)})`);

  // 找一个首页有数据的站。
  const data = await findDataSite(cdp);
  dataSiteKey = data.key;
  assert(!!dataSiteKey, "found a site with home list data", JSON.stringify(data));
  if (!dataSiteKey) throw new Error("no site returns a home list; cannot verify");
  console.log(`[info] data site: ${dataSiteKey} (${data.count} items)\n`);

  // --- 1. 记住用户切换 ---
  await coldStart(cdp);
  assert((await selectSite(cdp, dataSiteKey)) === "OK", "switch to data site via select");
  let cards = 0;
  for (let i = 0; i < 50; i += 1) {
    cards = (await cdp.eval(`document.querySelectorAll('.vod-card').length`)) || 0;
    if (cards > 0) break;
    await sleep(400);
  }
  assert(cards > 0, "data site renders cards", String(cards));
  const afterSwitch = JSON.parse((await snapshot(cdp)) || "{}");
  assert(afterSwitch.stored === dataSiteKey, "selected site persisted to localStorage", String(afterSwitch.stored));

  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  await cdp.eval(WAIT("return document.querySelector('select.select') ? 'OK' : null;", 30000));
  const afterReload = JSON.parse((await snapshot(cdp)) || "{}");
  assert(afterReload.selected === dataSiteKey, "reload keeps user-selected site", String(afterReload.selected));
  assert(afterReload.cards > 0, "reload keeps cards", String(afterReload.cards));

  // --- 2. 默认空站自动顺延 ---
  await coldStart(cdp); // 清偏好 → 默认站（豆瓣，空）
  const cold = JSON.parse((await snapshot(cdp)) || "{}");
  console.log(`[info] cold default site: ${cold.selected}`);
  let autoKey = null;
  for (let i = 0; i < 60; i += 1) {
    const s = JSON.parse((await snapshot(cdp)) || "{}");
    if (s.cards > 0) {
      autoKey = s.selected;
      break;
    }
    await sleep(400);
  }
  assert(!!autoKey, "cold default empty site auto-falls-back to a site with cards", String(autoKey));
  const afterFallback = JSON.parse((await snapshot(cdp)) || "{}");
  assert(
    afterFallback.stored && afterFallback.stored === afterFallback.selected,
    "auto-fallback site remembered for next launch",
    `stored=${afterFallback.stored} selected=${afterFallback.selected}`,
  );

  // --- 3. 尊重用户手动选的空站 ---
  await coldStart(cdp);
  // 手动切到豆瓣（首页只给分类不给列表）
  assert((await selectSite(cdp, "py_douban")) === "OK", "manually select an empty site");
  await sleep(2500); // 等 debounce + 一次加载 + 可能的（不应发生的）顺延
  const manual = JSON.parse((await snapshot(cdp)) || "{}");
  assert(manual.selected === "py_douban", "user-selected empty site is NOT auto-skipped", String(manual.selected));

  assert(cdp.errors.length === 0, "no uncaught page exceptions", cdp.errors.slice(0, 3).join(" | ").slice(0, 400));
} catch (err) {
  console.log(`[diag] ${String((err && err.stack) || err)}`);
  failures += 1;
} finally {
  // 收尾：恢复用户原本记住的站（或清掉，保持探针不留痕）。
  try {
    if (originalStored) {
      await cdp.eval(`localStorage.setItem(${JSON.stringify(HOME_SITE_KEY)}, ${JSON.stringify(originalStored)})`);
    } else {
      await cdp.eval(`localStorage.removeItem(${JSON.stringify(HOME_SITE_KEY)})`);
    }
    console.log(`[info] cleanup: restored home site pref`);
  } catch {
    /* ignore */
  }
  cdp.close();
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed step(s)`);
process.exit(failures === 0 ? 0 : 1);
