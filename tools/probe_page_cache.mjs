#!/usr/bin/env node
/**
 * 播放页返回详情页的「播放列表缓存」回归。
 *
 * 手段：Tauri 把 __TAURI_INTERNALS__.invoke 定义为不可写属性，直接包装
 * window.invoke 会静默失败（计数恒为 0）。改为通过 Vite dev 的动态 import
 * 拿到应用正在使用的 pageCache 单例，包装它的 load：只有真正执行 loader
 * 才计数，也就是真正发出 detailContent IPC 的次数。验证
 *   搜索 → 详情 → 播放 → 返回详情 全程不再重新拉取剧集列表，
 *   而点详情页「↻ 刷新」会强制重新请求，且返回详情时滚动位置被恢复。
 *
 * 依赖 dev 桌面窗口已在线（CDP 127.0.0.1:9222），沿用 SQLite active 配置。
 * 只 reload 一次并在其后立即注入 spy；reload 会清掉 window.__cacheSpy 和
 * 模块实例，之后绝不 reload。注入是幂等的，避免重复包装 / 重置计数。
 *
 *   node tools/probe_page_cache.mjs
 *
 * 截图写入 .workbuddy/page-cache.png；退出码 0 仅当全部断言通过且无未捕获页面异常。
 */
import { writeFileSync } from "node:fs";

const KEYWORD = "庆余年 第二季";
const SETTLE_MS = 2000;

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
    const path = `.workbuddy/${name}.png`;
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

// 按文本点按钮：先精确匹配，再退回包含匹配，selector 收窄范围。
const CLICK = (label, selector = "button, a") => `(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const text = (n) => (n.textContent || '').trim();
  const target = nodes.find((n) => text(n) === ${JSON.stringify(label)})
              || nodes.find((n) => text(n).includes(${JSON.stringify(label)}));
  if (!target) return 'MISSING';
  target.click();
  return 'CLICKED';
})()`;

// 按选择器点第一个匹配元素（.vod-card / .episode 等）。
const FIRST_CLICK = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'MISSING';
  el.click();
  return 'CLICKED';
})()`;

// 原生 setter + input 事件，兼容受控输入。
const TYPE = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'MISSING';
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'TYPED';
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

// 缓存层 spy 注入（幂等）。Vite dev 下动态 import 同一 URL 会命中浏览器模块
// 缓存，拿到的就是 App 正在用的那个 pageCache 单例；包装实例上的 load 后，
// 只有 loader 真正执行（= 真的发 IPC）才记一笔。
const INJECT_SPY = `(async () => {
  try {
    const m = await import('/src/lib/pageCache.ts');
    const cache = m.pageCache;
    if (!cache || typeof cache.load !== 'function') return 'NO_CACHE';
    if (cache.__cacheSpyWrapped) return 'ALREADY';
    const orig = cache.load.bind(cache);
    window.__cacheSpy = [];
    cache.load = (key, ttl, loader, force) => orig(key, ttl, () => {
      try { window.__cacheSpy.push({ key, force: !!force, at: Date.now() }); } catch {}
      return loader();
    }, force);
    cache.__cacheSpyWrapped = true;
    return true;
  } catch (e) { return 'ERR:' + String(e); }
})()`;

// 真正发出的 detailContent 请求次数。
const COUNT_EXPR = `(() => {
  if (!Array.isArray(window.__cacheSpy)) return -1;
  return window.__cacheSpy.filter(e => String(e.key).startsWith("detail:")).length;
})()`;

let cdp = null;
let c1 = -1;
let cPlay = -1;
let c2 = -1;
let c3 = -1;
let epCount1 = -1;
let savedScroll = -1;
let restoredScroll = -1;

const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

// 当前页面 DOM 快照：用 .player-bar / .detail-title 区分详情页与播放页，并给出诊断文本。
const pageState = () => cdp.eval(`(() => {
  const c = document.querySelector('.content');
  return JSON.stringify({
    playerBar: !!document.querySelector('.player-bar'),
    detailTitle: !!document.querySelector('.detail-title'),
    pageHead: !!document.querySelector('.page-head'),
    episodeCount: document.querySelectorAll('.episode').length,
    spinner: !!document.querySelector('.spinner'),
    scrollTop: c ? c.scrollTop : null,
    scrollHeight: c ? c.scrollHeight : null,
    clientHeight: c ? c.clientHeight : null,
    navItems: [...document.querySelectorAll('.nav__item')].map((n) => (n.textContent || '').trim()),
    bodySnippet: (document.body ? document.body.innerText : '').slice(0, 200),
  });
})()`);

const logState = async (tag) => {
  try {
    console.log(`[info] ${tag}: ${await pageState()}`);
  } catch (e) {
    console.log(`[diag] ${tag} page state unavailable: ${String(e)}`);
  }
};

const readCount = async (tag) => {
  const raw = await cdp.eval(COUNT_EXPR);
  const n = Number(raw);
  console.log(`[info] detailContent count @${tag}: ${String(raw)} (parsed ${n})`);
  return n;
};

const dumpSpy = () => cdp.eval(
  `JSON.stringify((Array.isArray(window.__cacheSpy) ? window.__cacheSpy : []).filter(e => String(e.key).startsWith("detail:")))`,
);

// 失败时给足诊断：body 文本片段 + 页面状态 + 未捕获异常 + IPC 明细。
const diag = async (tag) => {
  if (!cdp) {
    console.log(`[diag] ${tag} -- no CDP connection`);
    return;
  }
  try {
    const body = await cdp.eval(`document.body ? document.body.innerText.slice(0, 800) : '(no body)'`);
    console.log(`[diag] ${tag} -- page text: ${String(body)}`);
  } catch (e) {
    console.log(`[diag] ${tag} -- page text unavailable: ${String(e)}`);
  }
  await logState(tag);
  console.log(`[diag] ${tag} -- exceptions: ${cdp.errors.slice(0, 5).join(" | ").slice(0, 1200)}`);
  try {
    console.log(`[diag] ${tag} -- detailContent IPC entries: ${await dumpSpy()}`);
  } catch {
    /* ignore diagnostic failure */
  }
};

try {
  const page = await waitForPage();
  cdp = new Cdp(page.webSocketDebuggerUrl);
  console.log(`target: ${page.url}`);

  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  // 唯一一次 reload；之后不再 reload，否则 window.__cacheSpy 会被清空。
  await cdp.send("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 2500)); // 2~3s 等新 bundle 起来

  // --- Step 1: 等首页 shell + Tauri IPC 就绪，立即注入 spy ---
  const navReady = await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000));
  assert(navReady === "OK", "page reloaded, .nav__item rendered", String(navReady));
  if (navReady !== "OK") await diag("reload-nav-timeout");

  const tauriReady = await cdp.eval(
    WAIT("return (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') ? 'OK' : null;", 30000),
  );
  assert(tauriReady === "OK", "Tauri runtime ready", String(tauriReady));
  if (tauriReady !== "OK") await diag("tauri-not-ready");

  const injected = await cdp.eval(INJECT_SPY);
  assert(injected === true || injected === "ALREADY", "pageCache.load spy injected (idempotent)", String(injected));
  const spyReady = await cdp.eval(`Array.isArray(window.__cacheSpy) ? 'OK' : null`);
  assert(spyReady === "OK", "window.__cacheSpy array live after injection", String(spyReady));
  await logState("after-inject");

  // --- Step 2: 侧栏搜索 → 输入 → 提交 → 等聚合搜索完成（12~20s） ---
  const openSearch = await cdp.eval(CLICK("搜索", ".nav__item"));
  assert(openSearch === "CLICKED", "open search page via sidebar .nav__item 搜索", openSearch);
  const searchBarReady = await cdp.eval(WAIT("return document.querySelector('.search-bar input.input') ? 'OK' : null;", 15000));
  assert(searchBarReady === "OK", ".search-bar input.input rendered", String(searchBarReady));
  const typed = await cdp.eval(TYPE(".search-bar input.input", KEYWORD));
  assert(typed === "TYPED", `type keyword '${KEYWORD}' (native setter + input event)`, typed);
  const submitted = await cdp.eval(CLICK("搜索", ".search-bar button"));
  assert(submitted === "CLICKED", "submit search via .search-bar button (搜索)", submitted);
  const meta = await cdp.eval(
    WAIT("const el = document.querySelector('.result-meta'); return el && !document.querySelector('.spinner') ? (el.innerText || 'DONE') : null;", 60000),
  );
  assert(!!meta, "aggregate search finished (.result-meta shown, .spinner gone)", String(meta));
  if (!meta) await diag("search-not-finished");
  const cards = Number(await cdp.eval(`document.querySelectorAll('.vod-card').length`));
  assert(cards > 0, ".vod-card results rendered", `${cards} cards`);

  // --- Step 3: 第一个 .vod-card → 详情页，记录 c1 / 剧集数 / 滚动位置 ---
  const opened = await cdp.eval(FIRST_CLICK(".vod-card"));
  assert(opened === "CLICKED", "open first .vod-card", opened);
  // 明确等待「详情页」：.detail-title 存在、.player-bar 不存在、且 .episode 已出现。
  const detailReady = await cdp.eval(WAIT(`
    const eps = document.querySelectorAll('.episode');
    const onDetail = !!document.querySelector('.detail-title') && !document.querySelector('.player-bar');
    return onDetail && eps.length > 0 ? 'DETAIL' : null;
  `, 40000));
  assert(detailReady === "DETAIL", "detail page rendered (.detail-title + .episode, no .player-bar)", String(detailReady));
  if (detailReady !== "DETAIL") await diag("detail-load-failed");
  await logState("detail-ready");

  await settle(); // 等详情相关尾随 IPC 落定再读 c1
  c1 = await readCount("c1/detail");
  assert(c1 >= 1, "detail opened with >= 1 detailContent IPC call", `c1=${c1} (expected >= 1)`);
  if (c1 < 1) await diag("c1-too-small");
  epCount1 = Number(await cdp.eval(`document.querySelectorAll('.episode').length`));
  assert(epCount1 > 0, ".episode count > 0 on detail", `episodes=${epCount1}`);

  const scrollRaw = await cdp.eval(`(() => {
    const c = document.querySelector('.content');
    if (!c) return JSON.stringify({ ok: false, reason: 'NO_CONTENT' });
    c.scrollTop = 700;
    return JSON.stringify({ ok: true, scrollTop: c.scrollTop, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight });
  })()`);
  const scrollInfo = JSON.parse(scrollRaw || "{}");
  assert(scrollInfo.ok === true, ".content scroll container present", String(scrollRaw));
  savedScroll = scrollInfo.ok ? Number(scrollInfo.scrollTop) : -1;
  console.log(`[info] .content scroll: set=700 savedScroll=${savedScroll} scrollHeight=${scrollInfo.scrollHeight} clientHeight=${scrollInfo.clientHeight}`);
  if (savedScroll > 100) {
    assert(true, "detail page tall enough, .content.scrollTop > 100", `savedScroll=${savedScroll}`);
  } else {
    console.log(`[diag] .content too short to reach 700 (savedScroll=${savedScroll}, scrollHeight=${scrollInfo.scrollHeight}, clientHeight=${scrollInfo.clientHeight}); relax assertion to >= 0`);
    assert(savedScroll >= 0, ".content.scrollTop readable (relaxed >= 0)", `savedScroll=${savedScroll}`);
  }

  // --- Step 4: 第一个 .episode → 播放页；cPlay 必须等于 c1 ---
  const epClick = await cdp.eval(FIRST_CLICK(".episode"));
  assert(epClick === "CLICKED", "click first .episode to open player", epClick);
  if (epClick !== "CLICKED") await diag("episode-click-failed");
  // 明确等待「播放页」：.player-bar 存在且 .detail-title 不存在。
  const playerReady = await cdp.eval(WAIT(`
    return document.querySelector('.player-bar') && !document.querySelector('.detail-title') ? 'PLAYER' : null;
  `, 40000));
  assert(playerReady === "PLAYER", "player page rendered (.player-bar present, .detail-title absent)", String(playerReady));
  if (playerReady !== "PLAYER") await diag("player-load-failed");
  await logState("player-ready");

  await settle(); // 捕获播放页挂载时可能延迟触发的 detailContent
  cPlay = await readCount("cPlay/player");
  assert(cPlay === c1, "player page did NOT re-request detailContent (playlist cache reused)", `c1=${c1} cPlay=${cPlay} (expected equal)`);
  if (cPlay !== c1) await diag("cPlay-mismatch");

  // --- Step 5: ← 返回详情 → 详情页；c2 === c1，剧集数/无 spinner/滚动恢复 ---
  const back = await cdp.eval(CLICK("← 返回详情", "button, a"));
  assert(back === "CLICKED", "click player header ← 返回详情", back);
  if (back !== "CLICKED") await diag("back-button-missing");
  // 用 .player-bar / .detail-title 区分，确保回到的是详情页而非播放页选集面板。
  const backReady = await cdp.eval(WAIT(`
    const eps = document.querySelectorAll('.episode');
    const onDetail = !!document.querySelector('.detail-title') && !document.querySelector('.player-bar');
    return onDetail && eps.length > 0 ? 'DETAIL' : null;
  `, 40000));
  assert(backReady === "DETAIL", "returned to detail page (.detail-title + .episode, no .player-bar)", String(backReady));
  if (backReady !== "DETAIL") await diag("back-to-detail-failed");
  await logState("back-to-detail");

  await settle(); // 等滚动恢复(nextTick/rAF)与尾随 IPC
  c2 = await readCount("c2/back-to-detail");
  assert(c2 === c1, "back navigation did NOT reload playlist (c2 === c1)", `c1=${c1} c2=${c2} (expected equal)`);
  if (c2 !== c1) await diag("c2-mismatch");
  const epCount2 = Number(await cdp.eval(`document.querySelectorAll('.episode').length`));
  assert(epCount2 === epCount1, ".episode count unchanged after back", `step3=${epCount1} step5=${epCount2}`);
  const spinnerOnBack = await cdp.eval(`!!document.querySelector('.spinner')`);
  assert(spinnerOnBack === false, "no .spinner on restored detail page", `spinner=${spinnerOnBack}`);
  restoredScroll = Number(await cdp.eval(`(() => { const c = document.querySelector('.content'); return c ? c.scrollTop : -1; })()`));
  const scrollDiff = Math.abs(restoredScroll - savedScroll);
  assert(scrollDiff <= 30, ".content.scrollTop restored after back (diff <= 30)", `saved=${savedScroll} restored=${restoredScroll} diff=${scrollDiff}`);

  // --- Step 6: ↻ 刷新 → 强制重新请求；c3 >= c2 + 1 ---
  const refresh = await cdp.eval(CLICK("↻ 刷新", ".page-head button, .page-head a"));
  assert(refresh === "CLICKED", "click detail .page-head ↻ 刷新", refresh);
  if (refresh !== "CLICKED") await diag("refresh-button-missing");
  const refreshThreshold = c2 + 1;
  // 等一个「短暂无 spinner 的稳定态」且 detailContent 计数确实已 +1（刷新完成）。
  const refreshed = await cdp.eval(WAIT(`
    const cnt = Array.isArray(window.__cacheSpy) ? window.__cacheSpy.filter(e => String(e.key).startsWith("detail:")).length : -1;
    const stable = !document.querySelector('.spinner') && document.querySelectorAll('.episode').length > 0;
    return cnt >= ${refreshThreshold} && stable ? 'REFRESHED' : null;
  `, 15000));
  console.log(`[info] ↻ 刷新 settle: ${String(refreshed)}`);
  await new Promise((r) => setTimeout(r, 1000)); // 短尾随稳定态
  c3 = await readCount("c3/after-refresh");
  assert(c3 >= c2 + 1, "↻ 刷新 forced a new detailContent request (c3 >= c2 + 1)", `c2=${c2} c3=${c3} expected>=${c2 + 1}`);
  if (c3 < c2 + 1) await diag("c3-no-refresh");
  const epCount3 = Number(await cdp.eval(`document.querySelectorAll('.episode').length`));
  assert(epCount3 > 0, ".episode still rendered after refresh", `episodes=${epCount3}`);
} catch (err) {
  console.log(`[diag] unexpected error: ${String((err && err.stack) || err)}`);
  await diag("unexpected-error");
  failures += 1;
}

// 7. Runtime.exceptionThrown 为 0 + 截图 .workbuddy/page-cache.png（即使中途出错也尽量截）。
if (cdp) {
  assert(cdp.errors.length === 0, "no uncaught page exceptions (Runtime.exceptionThrown)", cdp.errors.slice(0, 3).join(" | ").slice(0, 600));
  try {
    await cdp.shot("page-cache");
  } catch (e) {
    console.log(`[FAIL] screenshot failed: ${String(e)}`);
    failures += 1;
  }
  try {
    console.log(`[info] detailContent IPC entries: ${await dumpSpy()}`);
  } catch {
    /* ignore diagnostic failure */
  }
  cdp.close();
} else {
  failures += 1;
  console.log("[FAIL] CDP connection not established; screenshot / exception checks skipped");
}

// 8. [ok]/[FAIL] 明细已由 assert 输出；这里打印计数与 PASS/FAIL 汇总。
console.log(`[info] counts: c1=${c1}  cPlay=${cPlay}  c2=${c2}  c3=${c3}  epCount1=${epCount1}  savedScroll=${savedScroll}  restoredScroll=${restoredScroll}`);
console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed step(s)`);
process.exit(failures === 0 ? 0 : 1);
