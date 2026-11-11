#!/usr/bin/env node
/**
 * 首页站点切换回归：
 *   1. 快速连续切换 3 个站点（间隔 60ms）→ 防抖后只发 1 次 `home` 请求，
 *      且请求的是最后一个站点、force=true（切站点自动刷新）；
 *   2. 重新选择当前站点 → 不发请求（防抖回调里直接取消）；
 *   3. 手动「刷新」按钮 → 再发 1 次 force 请求。
 *
 * 用 pageCache 的 load 计数（与 probe_page_cache 同法），只统计 `home:` 键。
 * 依赖 dev 窗口（CDP 9222）与至少 3 个可用站点。
 *   node tools/probe_home_refresh.mjs
 */
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

  close() {
    this.ws.close();
  }
}

async function waitForPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
      const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      const page =
        pages.find((t) => t.url.startsWith("http://localhost:1420")) ??
        pages.find((t) => !t.url.startsWith("edge://") && !t.url.startsWith("chrome://"));
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("CDP page target not found");
}

const WAIT = (expression, timeout = 20000) => `(async () => {
  const deadline = Date.now() + ${timeout};
  while (Date.now() < deadline) {
    const value = (() => { ${expression} })();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
})()`;

/** 动态 import 页面真实加载的 pageCache（HMR 后 URL 带 ?t=）。 */
const IMPORT_CACHE = `await (async () => {
  const pick = () => performance.getEntriesByType('resource').map((e) => e.name)
    .find((n) => /\\/src\\/lib\\/pageCache\\.ts(\\?|$)/.test(n));
  let hit = pick();
  for (let i = 0; i < 30 && !hit; i++) {
    await new Promise((r) => setTimeout(r, 100));
    hit = pick();
  }
  return import(hit ? hit.replace(location.origin, '') : '/src/lib/pageCache.ts');
})()`;

const SPY = `(async () => {
  const m = ${IMPORT_CACHE};
  const cache = m.pageCache;
  if (!cache || typeof cache.load !== 'function') return 'NO_CACHE';
  if (!cache.__homeSpyWrapped) {
    window.__homeSpy = [];
    const orig = cache.load.bind(cache);
    cache.load = (key, ttl, loader, force) => orig(key, ttl, () => {
      try { window.__homeSpy.push({ key, force: !!force, at: Date.now() }); } catch {}
      return loader();
    }, force);
    cache.__homeSpyWrapped = true;
  }
  return 'OK';
})()`;

const HOME_CALLS = `(() => {
  const all = Array.isArray(window.__homeSpy) ? window.__homeSpy : [];
  return JSON.stringify(all.filter((e) => String(e.key).startsWith('home:')));
})()`;

const RESET = `(() => { window.__homeSpy = []; return true; })()`;

const SET_SITE = (value) => `(() => {
  const el = document.querySelector('.page-head select');
  if (!el) return 'MISSING';
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'CHANGED';
})()`;

const OPTIONS = `(() => {
  const el = document.querySelector('.page-head select');
  if (!el) return null;
  return JSON.stringify({
    current: el.value,
    sites: [...el.options].filter((o) => !o.disabled).map((o) => o.value),
  });
})()`;

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
console.log(`target: ${page.url}`);

try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.reload", { ignoreCache: true });

  assert(
    (await cdp.eval(WAIT("return document.querySelector('.page-head select') ? 'OK' : null;", 30000))) === "OK",
    "home page rendered",
  );
  assert((await cdp.eval(SPY)) === "OK", "pageCache spy installed");
  // 等首屏请求落地，避免它混进后面的计数。
  await cdp.eval(WAIT("return !document.querySelector('.spinner') ? 'OK' : null;", 30000));
  await sleep(500);

  const optsRaw = await cdp.eval(OPTIONS);
  const opts = optsRaw ? JSON.parse(optsRaw) : null;
  console.log(`[info] options: ${optsRaw}`);
  assert(!!opts && opts.sites.length >= 3, "at least 3 selectable sites", optsRaw);
  if (!opts || opts.sites.length < 3) {
    throw new Error("not enough sites for debounce test");
  }

  const original = opts.current;
  const others = opts.sites.filter((key) => key !== original);
  const [a, b, c] = others;
  await cdp.eval(RESET);

  // 快速连切 A → B → C（60ms 一次），防抖后只应请求 C 一次。
  for (const key of [a, b, c]) {
    assert((await cdp.eval(SET_SITE(key))) === "CHANGED", `switch to ${key}`, key);
    await sleep(60);
  }
  await sleep(1500);
  await cdp.eval(WAIT("return !document.querySelector('.spinner') ? 'OK' : null;", 20000));
  await sleep(300);

  const calls = JSON.parse((await cdp.eval(HOME_CALLS)) || "[]");
  console.log(`[info] home calls: ${JSON.stringify(calls)}`);
  assert(calls.length === 1, "debounced to exactly 1 home request", JSON.stringify(calls));
  assert(calls[0]?.key === `home:${c}`, "request targets the last selected site", JSON.stringify(calls));
  assert(calls[0]?.force === true, "switching forces a refresh (cache skipped)", JSON.stringify(calls));

  const selected = await cdp.eval(
    `(() => { const el = document.querySelector('.page-head select'); return el ? el.value : null; })()`,
  );
  assert(selected === c, "select shows the last site", String(selected));

  // 重新选择当前站点：防抖回调里 next === siteKey，应取消请求。
  await cdp.eval(RESET);
  assert((await cdp.eval(SET_SITE(c))) === "CHANGED", "reselect current site", c);
  await sleep(900);
  const again = JSON.parse((await cdp.eval(HOME_CALLS)) || "[]");
  assert(again.length === 0, "reselecting current site sends no request", JSON.stringify(again));

  // 手动刷新按钮：立即 force 一次，不经过站点切换防抖。
  await cdp.eval(RESET);
  const refreshed = await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('.page-head button')].find((n) => (n.textContent || '').trim() === '刷新');
    if (!btn) return 'MISSING';
    btn.click();
    return 'CLICKED';
  })()`);
  assert(refreshed === "CLICKED", "click 刷新", refreshed);
  await sleep(900);
  const manual = JSON.parse((await cdp.eval(HOME_CALLS)) || "[]");
  console.log(`[info] manual refresh calls: ${JSON.stringify(manual)}`);
  assert(manual.length === 1 && manual[0].force === true, "manual refresh forces one request", JSON.stringify(manual));

  // 收尾：切回原站点（不关心请求结果，只为恢复现场）。
  await cdp.eval(SET_SITE(original));
  await sleep(800);
} catch (err) {
  console.log(`[diag] unexpected error: ${String((err && err.stack) || err)}`);
  failures += 1;
}

assert(
  cdp.errors.length === 0,
  "no uncaught page exceptions",
  cdp.errors.slice(0, 3).join(" | ").slice(0, 600),
);
cdp.close();
console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed step(s)`);
process.exit(failures === 0 ? 0 : 1);
