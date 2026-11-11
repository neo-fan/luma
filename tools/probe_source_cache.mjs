#!/usr/bin/env node
/**
 * 换源缓存 DOM + 行为契约回归：验证「搜索结果即缓存，点 ⇄ 换源不再重新检索」。
 *
 * 链路：reload → 侧栏搜索（真实聚合）→ 详情 → 点 ⇄ 换源，候选应在数秒内
 * 直出；期间 sourceCache.ensure 最多被后台补全调用一次、refresh(force) 为 0。
 * 最后切换一个源，确认详情仍可加载。
 *
 * 依赖 dev 桌面窗口已在线（CDP 127.0.0.1:9222）与真实 active 配置；
 * 不重新导入、不改 active。  node tools/probe_source_cache.mjs
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
  const text = (n) => (n.textContent || '').trim();
  const target = nodes.find((n) => text(n) === ${JSON.stringify(label)})
              || nodes.find((n) => text(n).includes(${JSON.stringify(label)}));
  if (!target) return 'MISSING';
  target.click();
  return 'CLICKED';
})()`;
const FIRST_CLICK = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'MISSING';
  el.click();
  return 'CLICKED';
})()`;
const TYPE = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'MISSING';
  const proto = HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'TYPED';
})()`;
const WAIT = (expression, timeout = 30000) => `(async () => {
  const deadline = Date.now() + ${timeout};
  while (Date.now() < deadline) {
    const value = (() => { ${expression} })();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
})()`;

/**
 * 取「页面实际加载的那份」sourceCache 模块 URL。
 *
 * Vite dev 在 HMR 之后会给 import 链加 `?t=<ts>` 时间戳；探针若用无参
 * `/src/lib/sourceCache.ts` 会拿到另一个模块实例，统计恒为 0。这里从
 * resource timing 里回读真实 URL，保证与 App 共用同一个单例。
 */
const IMPORT_CACHE = `await (async () => {
  const pick = () => performance.getEntriesByType('resource').map((e) => e.name)
    .find((n) => /\\/src\\/lib\\/sourceCache\\.ts(\\?|$)/.test(n));
  let hit = pick();
  for (let i = 0; i < 30 && !hit; i++) {
    await new Promise((r) => setTimeout(r, 100));
    hit = pick();
  }
  return import(hit ? hit.replace(location.origin, '') : '/src/lib/sourceCache.ts');
})()`;

/** 动态 import 拿同一个 sourceCache 单例，包一层调用计数。 */
const SPY = `(async () => {
  try {
    const m = ${IMPORT_CACHE};
    const c = m.sourceCache;
    if (!c) return 'NO_CACHE';
    if (!c.__probeWrapped) {
      window.__sourceSpy = { ensure: 0, refresh: 0 };
      const origEnsure = c.ensure.bind(c);
      const origRefresh = c.refresh.bind(c);
      c.ensure = (...args) => { window.__sourceSpy.ensure++; return origEnsure(...args); };
      c.refresh = (...args) => { window.__sourceSpy.refresh++; return origRefresh(...args); };
      c.__probeWrapped = true;
    }
    return 'OK';
  } catch (e) { return 'ERR:' + String(e); }
})()`;

const STATS = `(async () => {
  const m = ${IMPORT_CACHE};
  return JSON.stringify({ cache: m.sourceCache.stats(), spy: window.__sourceSpy || null });
})()`;

/** 用当前详情片名直接问缓存：true 表示无需 IPC 就有候选。 */
const VIEW_CACHED = `(async () => {
  const m = ${IMPORT_CACHE};
  const t = document.querySelector('.detail-title');
  if (!t) return 'NO_TITLE';
  const v = m.sourceCache.view(t.innerText.trim(), [], '');
  return JSON.stringify({ cached: v.cached, count: v.options.length, origin: v.origin, complete: v.complete });
})()`;

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const KEYWORD = process.env.LUMA_KEYWORD || process.env.TVBOX_KEYWORD || "走马上任";
const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
console.log(`target: ${page.url}  keyword: ${KEYWORD}`);

try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.reload", { ignoreCache: true });

  const navReady = await cdp.eval(
    WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000),
  );
  assert(navReady === "OK", "sidebar rendered", String(navReady));
  assert((await cdp.eval(SPY)) === "OK", "sourceCache singleton wrapped by spy");

  const opened = await cdp.eval(CLICK("搜索", ".nav__item"));
  assert(opened === "CLICKED", "open search page", opened);
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.search-bar input.input') ? 'OK' : null;", 15000))) === "OK",
    "search bar rendered",
  );
  assert((await cdp.eval(TYPE(".search-bar input.input", KEYWORD))) === "TYPED", "keyword typed");
  assert((await cdp.eval(FIRST_CLICK(".search-bar button"))) === "CLICKED", "search submitted");
  const meta = await cdp.eval(
    WAIT(
      "const el = document.querySelector('.result-meta'); return el && !document.querySelector('.spinner') ? el.innerText : null;",
      60000,
    ),
  );
  assert(!!meta, "aggregate search finished", String(meta).slice(0, 120));

  const afterSearchRaw = await cdp.eval(STATS);
  const afterSearch = JSON.parse(afterSearchRaw || "{}");
  console.log(`[info] after search: ${afterSearchRaw}`);
  assert(
    (afterSearch.cache?.publishes ?? 0) >= 1,
    "search published results into sourceCache",
    afterSearchRaw,
  );
  assert(
    (afterSearch.cache?.aggregateCalls ?? -1) === 0,
    "search itself did not go through sourceCache prefetch",
    afterSearchRaw,
  );

  // 详情：拿到片名后先确认缓存可直接派生候选。
  assert((await cdp.eval(FIRST_CLICK(".vod-card"))) === "CLICKED", "open first .vod-card");
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.detail-title') ? 'OK' : null;", 30000))) === "OK",
    "detail page rendered",
  );
  const viewRaw = await cdp.eval(VIEW_CACHED);
  const view = viewRaw && viewRaw.startsWith("{") ? JSON.parse(viewRaw) : null;
  console.log(`[info] cached view: ${viewRaw}`);
  assert(!!view?.cached && view.count > 0, "source candidates derivable from cache", viewRaw);

  // 点 ⇄ 换源：候选必须立刻出现，且不得触发手动刷新(force)检索。
  const beforeRaw = await cdp.eval(STATS);
  const before = JSON.parse(beforeRaw || "{}");
  const swap = await cdp.eval(CLICK("⇄ 换源", ".page-head button, .page-head a"));
  assert(swap === "CLICKED", "open source-picker", swap);
  const fast = await cdp.eval(
    WAIT("return document.querySelectorAll('.source-item').length >= 1 ? 'READY' : null;", 3000),
  );
  assert(fast === "READY", "candidates rendered within 3s (no 20s re-search)", String(fast));
  const afterRaw = await cdp.eval(STATS);
  const after = JSON.parse(afterRaw || "{}");
  console.log(`[info] before picker: ${beforeRaw}`);
  console.log(`[info] after  picker: ${afterRaw}`);
  assert(
    (after.spy?.refresh ?? -1) === (before.spy?.refresh ?? -2),
    "opening picker did not call refresh(force)",
    `${JSON.stringify(before.spy)} -> ${JSON.stringify(after.spy)}`,
  );
  assert(
    (after.spy?.ensure ?? 0) - (before.spy?.ensure ?? 0) <= 1,
    "at most one background ensure, no picker-triggered re-search",
    `${JSON.stringify(before.spy)} -> ${JSON.stringify(after.spy)}`,
  );

  const pickerRaw = await cdp.eval(`(() => {
    const p = document.querySelector('.source-picker');
    if (!p) return null;
    const m = p.querySelector('.source-picker__meta');
    const badge = p.querySelector('.source-cache-badge');
    return JSON.stringify({
      items: p.querySelectorAll('.source-item').length,
      badge: badge ? badge.innerText.trim() : null,
      meta: m ? m.innerText.trim() : null,
      spinner: !!p.querySelector('.spinner'),
    });
  })()`);
  const picker = pickerRaw ? JSON.parse(pickerRaw) : null;
  console.log(`[info] picker: ${pickerRaw}`);
  assert(!!picker?.badge?.includes("已缓存"), "cache badge shown", pickerRaw);
  assert(!!picker?.meta?.includes("个站点"), "meta keeps 个站点 contract", pickerRaw);
  assert(picker?.spinner === false, "no loading spinner on cache hit", pickerRaw);

  // 切换第一个候选：面板必须关闭，且详情页给出结果（标题或错误提示）。
  // 「切源后一定能播放」由 probe_source_picker 覆盖；本探针只关心缓存行为，
  // 真实源站偶发 detailContent 失败时不应把它记成缓存回归失败。
  const beforeSource = await cdp.eval(`(() => { const e = document.querySelector('.detail-source'); return e ? e.innerText.trim() : null; })()`);
  const switched = await cdp.eval(FIRST_CLICK(".source-item .btn"));
  assert(switched === "CLICKED", "click first 切换", switched);
  const settled = await cdp.eval(
    WAIT("return !document.querySelector('.source-picker') && (document.querySelector('.detail-title') || document.querySelector('.error-bar')) ? 'OK' : null;", 30000),
  );
  assert(settled === "OK", "detail page settled after switching source", String(settled));
  const afterSource = await cdp.eval(`(() => { const e = document.querySelector('.detail-source'); return e ? e.innerText.trim() : null; })()`);
  if (afterSource && afterSource !== beforeSource) {
    console.log(`[ok  ] detail source changed  -- ${beforeSource} -> ${afterSource}`);
  } else {
    console.log(`[info] source switch settled without a loaded detail (源站波动，切换链路由 probe_source_picker 覆盖)`);
  }
} catch (err) {
  console.log(`[diag] unexpected error: ${String((err && err.stack) || err)}`);
  try {
    console.log(`[diag] page text: ${String(await cdp.eval("document.body.innerText.slice(0, 800)"))}`);
  } catch {
    /* ignore */
  }
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
