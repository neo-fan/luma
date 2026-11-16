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
 *   node tools/probes/probe_page_cache.mjs
 *
 * 截图写入 tools/.out/page-cache.png；退出码 0 仅当全部断言通过且无未捕获页面异常。
 */
import { writeFileSync } from "node:fs";

const KEYWORD = "走马上任";
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

// 按文本点按钮：先精确匹配，再退回包含匹配，selector 收窄范围。
// 图标按钮没有 textContent，所以同时匹配 aria-label（UI 已改成图标态）。
const CLICK = (label, selector = "button, a") => `(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const text = (n) => (n.textContent || '').trim();
  const aria = (n) => n.getAttribute('aria-label') || '';
  const target = nodes.find((n) => text(n) === ${JSON.stringify(label)} || aria(n) === ${JSON.stringify(label)})
              || nodes.find((n) => text(n).includes(${JSON.stringify(label)}) || aria(n).includes(${JSON.stringify(label)}));
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

// 当前页面 DOM 快照：路由页挂在 main.content 里；播放器是 AppShell 下的常驻层
// (.player-host)，返回详情后它仍 mounted（.is-idle），所以 .player-about / .episode
// 会同时存在于详情页与隐藏播放页。判页与计数一律 scope 到 main.content，否则详情会被
// 算成「detail + player 叠加」（剧集翻倍、playerBar 恒真）。滚动只在 .page-body
// （layout.css:396-404；.content overflow:hidden，不滚）。
const pageState = () => cdp.eval(`(() => {
  const body = document.querySelector('.content .page-body');
  return JSON.stringify({
    hash: location.hash,
    playerActive: !!document.querySelector('.player-host:not(.is-idle) .player-about'),
    playerAboutAny: !!document.querySelector('.player-about'),
    detailTitle: !!document.querySelector('.content .detail-title'),
    pageHead: !!document.querySelector('.content .page-head'),
    episodeCount: document.querySelectorAll('.content .episode').length,
    spinner: !!document.querySelector('.content .spinner'),
    scrollTop: body ? Math.round(body.scrollTop) : null,
    scrollHeight: body ? body.scrollHeight : null,
    clientHeight: body ? body.clientHeight : null,
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

  // --- Step 3: 找一张「有剧集」的卡 → 详情页，记录 c1 / 剧集数 / 滚动位置 ---
  // 聚合搜索是多源混排，第一张卡可能落在「只给推荐、没有播放列表」的发现源上
  // （空详情是已知能力缺口，不是缓存回归）。最多试 5 张，避免探针被数据带偏。
  let detailReady = null;
  let tried = 0;
  for (; tried < 5; tried += 1) {
    const opened = await cdp.eval(`(() => {
      const card = document.querySelectorAll('.vod-card')[${tried}];
      if (!card) return 'MISSING';
      card.click();
      return 'CLICKED';
    })()`);
    if (opened !== "CLICKED") break;
    // 明确等待「详情页」：路由在 #/detail/，main.content 里有 .detail-title，且
    // .content .episode 已出现。判页 scope 到 .content，避开常驻播放层的叠加 DOM。
    detailReady = await cdp.eval(WAIT(`
      const eps = document.querySelectorAll('.content .episode');
      const onDetail = location.hash.startsWith('#/detail/') && !!document.querySelector('.content .detail-title');
      return onDetail && eps.length > 0 ? 'DETAIL' : null;
    `, 30000));
    if (detailReady === "DETAIL") break;
    // 这张卡没有剧集：返回搜索结果，换下一张。
    await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('.page-head button')].find(
        (n) => (n.getAttribute('aria-label') || '') === '返回',
      );
      if (b) b.click();
      return !!b;
    })()`);
    await cdp.eval(WAIT("return document.querySelector('.search-bar input.input') ? 'OK' : null;", 15000));
    await new Promise((r) => setTimeout(r, 400));
  }
  assert(
    detailReady === "DETAIL",
    `detail page rendered (#/detail route + .content .detail-title + .content .episode) after ${tried + 1} card(s)`,
    String(detailReady),
  );
  if (detailReady !== "DETAIL") await diag("detail-load-failed");
  await logState("detail-ready");

  await settle(); // 等详情相关尾随 IPC 落定再读 c1
  c1 = await readCount("c1/detail");
  assert(c1 >= 1, "detail opened with >= 1 detailContent IPC call", `c1=${c1} (expected >= 1)`);
  if (c1 < 1) await diag("c1-too-small");
  epCount1 = Number(await cdp.eval(`document.querySelectorAll('.content .episode').length`));
  assert(epCount1 > 0, ".content .episode count > 0 on detail", `episodes=${epCount1}`);

  // 滚动行程取中点而不是「滚到底」：详情页在离开/返回之间会发生内容回流（封面图
  // 加载完、源切换提示条出现或收起），scrollHeight 一变，浏览器就会把 scrollTop 钳到
  // 新的 maxScroll —— 边界值上做定值比较会把「恢复其实生效了」误判成回归。
  const scrollRaw = await cdp.eval(`(() => {
    const c = document.querySelector('.content .page-body');
    if (!c) return JSON.stringify({ ok: false, reason: 'NO_PAGE_BODY' });
    const max = c.scrollHeight - c.clientHeight;
    c.scrollTop = Math.round(max / 2);
    return JSON.stringify({
      ok: true,
      scrollTop: Math.round(c.scrollTop),
      scrollHeight: c.scrollHeight,
      clientHeight: c.clientHeight,
      maxScroll: max,
    });
  })()`);
  const scrollInfo = JSON.parse(scrollRaw || "{}");
  assert(scrollInfo.ok === true, "detail .page-body scroll container present", String(scrollRaw));
  savedScroll = scrollInfo.ok ? Number(scrollInfo.scrollTop) : -1;
  console.log(`[info] .page-body scroll: target=mid savedScroll=${savedScroll} scrollHeight=${scrollInfo.scrollHeight} clientHeight=${scrollInfo.clientHeight} maxScroll=${scrollInfo.maxScroll}`);
  // 详情页在弱网/小图状态下滚动行程可能只有几十像素（实测 67），所以门槛保持低位；
  // 代价是要靠「紧容差」而不是「大行程」来保证灵敏度 —— 恢复机制本身是定值写入
  // （AppShell 同步写一次 + rAF 再写一次），容差 12px 足够吸收布局动画的抖动。
  const scrollTestable = Number(scrollInfo.maxScroll) >= 40;

  // --- Step 4: 第一个 .episode → 播放页；cPlay 必须等于 c1 ---
  const epClick = await cdp.eval(FIRST_CLICK(".content .episode"));
  assert(epClick === "CLICKED", "click first .content .episode to open player", epClick);
  if (epClick !== "CLICKED") await diag("episode-click-failed");
  // 明确等待「播放页」：路由在 #/player/，且常驻播放层处于激活态（非 .is-idle）。
  // .player-about 在返回详情后仍留在 DOM（隐藏常驻层），所以不能用它是否消失判页。
  const playerReady = await cdp.eval(WAIT(`
    return location.hash.startsWith('#/player/') && document.querySelector('.player-host:not(.is-idle) .player-about') ? 'PLAYER' : null;
  `, 40000));
  assert(playerReady === "PLAYER", "player page rendered (#/player route + active .player-host .player-about)", String(playerReady));
  if (playerReady !== "PLAYER") await diag("player-load-failed");
  await logState("player-ready");

  await settle(); // 捕获播放页挂载时可能延迟触发的 detailContent
  cPlay = await readCount("cPlay/player");
  assert(cPlay === c1, "player page did NOT re-request detailContent (playlist cache reused)", `c1=${c1} cPlay=${cPlay} (expected equal)`);
  if (cPlay !== c1) await diag("cPlay-mismatch");

  // --- Step 5: ← 返回详情 → 详情页；c2 === c1，剧集数/无 spinner/滚动恢复 ---
  const back = await cdp.eval(CLICK("返回详情", "button, a"));
  assert(back === "CLICKED", "click player header 返回详情 icon", back);
  if (back !== "CLICKED") await diag("back-button-missing");
  // 用路由 + main.content 内的选择器判页，确保回到的是详情页（常驻播放层此时 is-idle）。
  const backReady = await cdp.eval(WAIT(`
    const eps = document.querySelectorAll('.content .episode');
    const onDetail = location.hash.startsWith('#/detail/') && !!document.querySelector('.content .detail-title');
    return onDetail && eps.length > 0 ? 'DETAIL' : null;
  `, 40000));
  assert(backReady === "DETAIL", "returned to detail page (#/detail route + .content .detail-title + .content .episode)", String(backReady));
  if (backReady !== "DETAIL") await diag("back-to-detail-failed");
  await logState("back-to-detail");

  await settle(); // 等滚动恢复(nextTick/rAF)与尾随 IPC
  c2 = await readCount("c2/back-to-detail");
  assert(c2 === c1, "back navigation did NOT reload playlist (c2 === c1)", `c1=${c1} c2=${c2} (expected equal)`);
  if (c2 !== c1) await diag("c2-mismatch");
  const epCount2 = Number(await cdp.eval(`document.querySelectorAll('.content .episode').length`));
  assert(epCount2 === epCount1, ".content .episode count unchanged after back", `step3=${epCount1} step5=${epCount2}`);
  const spinnerOnBack = await cdp.eval(`!!document.querySelector('.content .spinner')`);
  assert(spinnerOnBack === false, "no .spinner on restored detail page", `spinner=${spinnerOnBack}`);
  const restoredRaw = await cdp.eval(`(() => {
    const c = document.querySelector('.content .page-body');
    if (!c) return JSON.stringify({ scrollTop: -1, maxScroll: null });
    return JSON.stringify({
      scrollTop: Math.round(c.scrollTop),
      maxScroll: c.scrollHeight - c.clientHeight,
    });
  })()`);
  const restored = JSON.parse(restoredRaw || "{}");
  restoredScroll = Number(restored.scrollTop);
  // 不变量：返回详情后 `.page-body` 应回到离开时的位置。比较基准取
  // `min(saved, 当前 maxScroll)`：返回时文档若变矮，落到底就是浏览器允许的
  // 最接近位置（产品侧的滚动锚点是 AppShell 的 scrollHost → `.page-body`，
  // `.content` 本身 overflow:hidden 不滚）。另一条下限断言守住真正的回归形态：
  // 位置被抹平回顶部。
  if (scrollTestable) {
    const expected = Math.min(savedScroll, Number(restored.maxScroll ?? savedScroll));
    const scrollDiff = Math.abs(restoredScroll - expected);
    assert(
      scrollDiff <= 12,
      ".page-body.scrollTop restored after back (clamp-aware, diff <= 12)",
      `saved=${savedScroll} maxNow=${restored.maxScroll} expected=${expected} restored=${restoredScroll} diff=${scrollDiff}`,
    );
    assert(
      restoredScroll > 0,
      "restored scroll is not flattened to top",
      `saved=${savedScroll} restored=${restoredScroll}`,
    );
  } else {
    console.log(`[diag] detail .page-body 没有足够滚动行程（maxScroll=${scrollInfo.maxScroll}），无法验证恢复，跳过本项`);
  }

  // --- Step 6: ↻ 刷新 → 强制重新请求；c3 >= c2 + 1 ---
  const refresh = await cdp.eval(CLICK("刷新", ".page-head button, .page-head a"));
  assert(refresh === "CLICKED", "click detail .page-head 刷新 icon", refresh);
  if (refresh !== "CLICKED") await diag("refresh-button-missing");
  const refreshThreshold = c2 + 1;
  // 等一个「短暂无 spinner 的稳定态」且 detailContent 计数确实已 +1（刷新完成）。
  const refreshed = await cdp.eval(WAIT(`
    const cnt = Array.isArray(window.__cacheSpy) ? window.__cacheSpy.filter(e => String(e.key).startsWith("detail:")).length : -1;
    const stable = !document.querySelector('.content .spinner') && document.querySelectorAll('.content .episode').length > 0;
    return cnt >= ${refreshThreshold} && stable ? 'REFRESHED' : null;
  `, 15000));
  console.log(`[info] ↻ 刷新 settle: ${String(refreshed)}`);
  await new Promise((r) => setTimeout(r, 1000)); // 短尾随稳定态
  c3 = await readCount("c3/after-refresh");
  assert(c3 >= c2 + 1, "↻ 刷新 forced a new detailContent request (c3 >= c2 + 1)", `c2=${c2} c3=${c3} expected>=${c2 + 1}`);
  if (c3 < c2 + 1) await diag("c3-no-refresh");
  // 强制刷新会重新拉源站，慢源可能十几秒后才把剧集渲染回来；等它出现再断言，
  // 而不是在固定尾随等待后立刻读一次 DOM（那样会把加载中误判成数据丢失）。
  // 外网源偶发「force 一次返回空列表」：再点一次刷新，别把源的瞬时抖动记成回归。
  let epCount3 = Number(
    (await cdp.eval(WAIT(`
    const n = document.querySelectorAll('.content .episode').length;
    return n > 0 ? String(n) : null;
  `, 30000))) || 0,
  );
  if (epCount3 === 0) {
    console.log("[info] first forced refresh came back empty, retrying once");
    await cdp.eval(CLICK("刷新", ".page-head button, .page-head a"));
    epCount3 = Number(
      (await cdp.eval(WAIT(`
      const n = document.querySelectorAll('.content .episode').length;
      return n > 0 ? String(n) : null;
    `, 40000))) || 0,
    );
  }
  const errText = await cdp.eval(`document.querySelector('.content .error-bar__text')?.textContent?.trim() || ''`);
  assert(
    epCount3 > 0,
    ".content .episode still rendered after refresh",
    `episodes=${epCount3}${errText ? ` error=${errText}` : ""}`,
  );
} catch (err) {
  console.log(`[diag] unexpected error: ${String((err && err.stack) || err)}`);
  await diag("unexpected-error");
  failures += 1;
}

// 7. Runtime.exceptionThrown 为 0 + 截图 tools/.out/page-cache.png（即使中途出错也尽量截）。
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
