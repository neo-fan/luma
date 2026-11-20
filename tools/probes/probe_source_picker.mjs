#!/usr/bin/env node
/**
 * 手动换源（source-picker）DOM 契约回归：真实 active 配置，走完整链路
 *   侧栏搜索 → 详情 → ⇄换源 → 取消/恢复筛选 → 切换源 → 播放 → 选集 → 播放页换源/关闭。
 *
 * 依赖 dev 桌面窗口已在线（CDP 127.0.0.1:9222），沿用 SQLite 里的 active 配置，
 * 不重新导入、不重启服务；开头会 Page.reload 以加载最新前端 bundle。
 *   node tools/probes/probe_source_picker.mjs
 *
 * 截图写入 tools/.out/source-picker.png 与 tools/.out/player-episodes.png。
 * 每一步 assert；任一失败或出现未捕获页面异常即以退出码 1 结束。
 */
import { writeFileSync } from "node:fs";
import { NAV_READY, reloadAndWait, waitEval } from "./lib/probeWait.mjs";

const KEYWORD = "走马上任";

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
    // png 在本机 WebView2 上偶发超时（已踩多次），jpeg 稳定且足够看清布局。
    const res = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 85 });
    const path = `tools/.out/${name}.jpg`;
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

// 按文本点按钮：先精确匹配，再退回包含匹配（兼容图标/空白），selector 收窄范围。
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

// 按选择器点第一个匹配元素（.search-bar button / .vod-card / .episode 等）。
const FIRST_CLICK = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'MISSING';
  el.click();
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
console.log(`target: ${page.url}`);

try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  // 每次都从最新 bundle 起跑，避免窗口停留在上一次 HMR 的中间态。
  // reload 会销毁执行上下文：页内 WAIT 整条落进旧上下文会拿到假绿
  // （旧 DOM 同样有 .nav__item，2026-11-20 套件实测 boot 假绿后整串假红），
  // 必须用宿主侧两段式 reloadAndWait，在确认新上下文后再等侧栏文本。
  const navRaw = await reloadAndWait(cdp, NAV_READY, 45000);
  assert(Boolean(navRaw), "page reloaded with latest bundle", String(navRaw));
  const nav = JSON.parse(navRaw || "[]");
  assert(
    nav.some((t) => t.includes("首页")) && nav.some((t) => t.includes("搜索")),
    "sidebar has 首页 / 搜索",
    JSON.stringify(nav),
  );
  const openSearch = await cdp.eval(CLICK("搜索", ".nav__item"));
  assert(openSearch === "CLICKED", "open search page via sidebar", openSearch);
  const searchBarReady = await cdp.eval(
    WAIT("return document.querySelector('.search-bar input.input') ? 'OK' : null;", 15000),
  );
  assert(searchBarReady === "OK", ".search-bar input.input rendered", String(searchBarReady));
  const typed = await cdp.eval(TYPE(".search-bar input.input", KEYWORD));
  assert(typed === "TYPED", `type keyword ${KEYWORD}`, typed);
  // 提交用表单 requestSubmit：search-bar 里「清除」(keyword 非空时) 与自定义
  // SiteSelect 触发器都在「搜索」按钮之前（SearchPage.tsx:641/653/659），
  // 点 `.search-bar button` 首个命中是清除按钮，关键词被清空、永不提交。
  const submitted = await cdp.eval(`(() => {
    const input = document.querySelector('.search-bar input.input');
    if (!input) return 'MISSING';
    input.closest('form').requestSubmit();
    return 'CLICKED';
  })()`);
  assert(submitted === "CLICKED", "submit search via form.requestSubmit", submitted);
  const meta = await cdp.eval(
    WAIT(
      "const el = document.querySelector('.result-meta'); return el && !document.querySelector('.spinner') ? el.innerText : null;",
      60000,
    ),
  );
  assert(!!meta, "aggregate search finished (.result-meta shown, .spinner gone)", String(meta));
  const cards = Number(await cdp.eval(`document.querySelectorAll('.vod-card').length`));
  assert(cards > 0, "search .vod-card results rendered", `${cards} cards`);

  // 2. 详情：等「播放线路」，记录切换前 .detail-source 文本。
  // 聚合结果是多源混排，第一张卡可能是只给推荐的发现源（空详情是已知缺口），
  // 换下一张继续，最多试 5 张。
  let detail = null;
  let cardIndex = 0;
  for (; cardIndex < 5; cardIndex += 1) {
    const opened = await cdp.eval(`(() => {
      const card = document.querySelectorAll('.vod-card')[${cardIndex}];
      if (!card) return 'MISSING';
      card.click();
      return 'CLICKED';
    })()`);
    if (opened !== "CLICKED") break;
    detail = await cdp.eval(
      WAIT("return document.body.innerText.includes('播放线路') ? 'OK' : null;", 25000),
    );
    if (detail === "OK") break;
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
  assert(detail === "OK", `detail page rendered (播放线路) after ${cardIndex + 1} card(s)`, String(detail));
  const detailRaw = await cdp.eval(`(() => {
    const head = document.querySelector('.page-head');
    const swap = head
      ? [...head.querySelectorAll('button, a')].some(
          (n) =>
            (n.textContent || '').includes('换源') ||
            (n.getAttribute('aria-label') || '') === '换源',
        )
      : false;
    const src = document.querySelector('.detail-source');
    const title = document.querySelector('.detail-title');
    return JSON.stringify({
      hasPageHead: !!head,
      hasSwapBtn: swap,
      hasDetailTitle: !!title,
      titleText: title ? title.innerText.trim() : null,
      hasDetailSource: !!src,
      sourceText: src ? src.innerText.trim() : null,
      episodeCount: document.querySelectorAll('.episode').length,
      hasLineText: document.body.innerText.includes('播放线路'),
    });
  })()`);
  const d = JSON.parse(detailRaw || "{}");
  assert(!!d.hasPageHead, ".page-head present", JSON.stringify(d));
  assert(!!d.hasSwapBtn, ".page-head has 换源 icon button", JSON.stringify(d));
  assert(!!d.hasDetailTitle && !!d.titleText, ".detail-title present and non-empty", JSON.stringify(d));
  assert(!!d.hasDetailSource && !!d.sourceText, ".detail-source present and non-empty", JSON.stringify(d));
  const beforeSource = d.sourceText;

  // 3. 换源图标 → .source-picker，等候选行，校验完整 DOM 契约并截图。
  const openPicker = await cdp.eval(CLICK("换源", ".page-head button, .page-head a"));
  assert(openPicker === "CLICKED", "open source-picker from detail .page-head", openPicker);
  const pickerShown = await cdp.eval(
    WAIT("return document.querySelector('.source-picker') ? 'OPEN' : null;", 10000),
  );
  assert(pickerShown === "OPEN", ".source-picker opened", String(pickerShown));
  const itemsReady = await cdp.eval(
    WAIT("return document.querySelectorAll('.source-item').length >= 1 ? 'READY' : null;", 30000),
  );
  assert(itemsReady === "READY", "at least one .source-item rendered", String(itemsReady));
  const snapRaw = await cdp.eval(`(() => {
    const picker = document.querySelector('.source-picker');
    if (!picker) return null;
    const searchInput = picker.querySelector('.source-picker__search input.input');
    const researchBtn = [...picker.querySelectorAll('button, a')].some((n) => (n.textContent || '').includes('重新搜索'));
    const metaEl = picker.querySelector('.source-picker__meta');
    const filterToggle = picker.querySelector('.filter-toggle');
    const checkbox = picker.querySelector('.filter-toggle input');
    // 关闭是图标按钮（没有 ✕ 文案），按 aria-label 判定。
    const closeBtn = [...picker.querySelectorAll('button, a')].some(
      (n) => (n.getAttribute('aria-label') || '') === '关闭' || (n.textContent || '').includes('✕'),
    );
    const items = [...picker.querySelectorAll('.source-item')];
    const first = items[0];
    return JSON.stringify({
      hasOverlay: !!document.querySelector('.overlay'),
      hasTitle: (picker.innerText || '').includes('手动换源'),
      hasSearchInput: !!searchInput,
      hasResearchBtn: researchBtn,
      metaText: metaEl ? metaEl.innerText.trim() : null,
      hasFilterToggle: !!filterToggle,
      hasFilterLabel: (picker.innerText || '').includes('只看片名匹配'),
      checkboxExists: !!checkbox,
      checkboxChecked: checkbox ? checkbox.checked : null,
      itemCount: items.length,
      firstItemHasSite: first ? !!first.querySelector('.source-item__site') : false,
      firstItemHasTitle: first ? !!first.querySelector('.source-item__title') : false,
      firstItemHasSwitch: first ? [...first.querySelectorAll('button, a')].some((n) => (n.textContent || '').includes('切换')) : false,
      hasCloseBtn: closeBtn,
    });
  })()`);
  const snap = snapRaw ? JSON.parse(snapRaw) : null;
  assert(!!snap, ".source-picker snapshot captured", String(snapRaw));
  if (snap) {
    assert(!!snap.hasOverlay, ".overlay mask present", JSON.stringify(snap));
    assert(!!snap.hasTitle, ".source-picker title 手动换源", JSON.stringify(snap));
    assert(!!snap.hasSearchInput, ".source-picker__search input.input present", JSON.stringify(snap));
    assert(!!snap.hasResearchBtn, "重新搜索 button present", JSON.stringify(snap));
    assert(!!snap.metaText && snap.metaText.includes("个站点"), ".source-picker__meta 含「个站点」", JSON.stringify(snap.metaText));
    assert(!!snap.hasFilterToggle && !!snap.hasFilterLabel, ".filter-toggle + 只看片名匹配 label present", JSON.stringify(snap));
    assert(!!snap.checkboxExists && snap.checkboxChecked === true, ".filter-toggle input default checked", JSON.stringify(snap));
    assert(snap.itemCount >= 1, ".source-item rows present", JSON.stringify(snap.itemCount));
    assert(!!snap.firstItemHasSite, "first .source-item__site present", JSON.stringify(snap));
    assert(!!snap.firstItemHasTitle, "first .source-item__title present", JSON.stringify(snap));
    assert(!!snap.firstItemHasSwitch, "first row 切换 button present", JSON.stringify(snap));
    // 关闭是图标按钮，语义在 aria-label 上。
    assert(!!snap.hasCloseBtn, "关闭 icon button present", JSON.stringify(snap));
  }
  await cdp.shot("source-picker");

  // 4. 取消勾选 → 候选数不减少 → 勾回来。
  const countBefore = Number(await cdp.eval(`document.querySelectorAll('.source-item').length`));
  const uncheck = await cdp.eval(`(() => {
    const cb = document.querySelector('.source-picker .filter-toggle input');
    if (!cb) return 'MISSING';
    if (!cb.checked) return 'ALREADY_UNCHECKED';
    cb.click();
    return cb.checked ? 'STILL_CHECKED' : 'UNCHECKED';
  })()`);
  assert(uncheck === "UNCHECKED", "uncheck .filter-toggle input via el.click()", String(uncheck));
  const settle = await cdp.eval(
    WAIT(`const n = document.querySelectorAll('.source-item').length; return n >= ${countBefore} ? n : null;`, 30000),
  );
  assert(settle !== null, "unchecking filter did not reduce .source-item count", JSON.stringify({ before: countBefore, after: settle }));
  const recheck = await cdp.eval(`(() => {
    const cb = document.querySelector('.source-picker .filter-toggle input');
    if (!cb) return 'MISSING';
    if (!cb.checked) cb.click();
    return cb.checked ? 'CHECKED' : 'STILL_UNCHECKED';
  })()`);
  assert(recheck === "CHECKED", "re-check .filter-toggle input", String(recheck));

  // 5. 第一个 .source-item 的「切换」→ picker 消失 → 源变更、标题仍在。
  const switched = await cdp.eval(`(() => {
    const item = document.querySelector('.source-item');
    if (!item) return 'MISSING_ITEM';
    const btns = [...item.querySelectorAll('button, a')];
    const btn = btns.find((n) => (n.textContent || '').trim() === '切换')
             || btns.find((n) => (n.textContent || '').includes('切换'));
    if (!btn) return 'MISSING_BTN';
    btn.click();
    return 'CLICKED';
  })()`);
  assert(switched === "CLICKED", "click first .source-item 切换 button", switched);
  const closed = await cdp.eval(
    WAIT("return document.querySelector('.source-picker') ? null : 'CLOSED';", 15000),
  );
  assert(closed === "CLOSED", ".source-picker closed after 切换", String(closed));
  // 换源会重建详情页并重新拉详情，等标题回来再读源名，别把加载态当失败。
  const detailReloaded = await cdp.eval(
    WAIT("return document.querySelector('.detail-title') ? 'OK' : null;", 30000),
  );
  assert(detailReloaded === "OK", "detail reloaded for picked source", String(detailReloaded));
  const afterRaw = await cdp.eval(`(() => {
    const src = document.querySelector('.detail-source');
    const title = document.querySelector('.detail-title');
    return JSON.stringify({
      source: src ? src.innerText.trim() : null,
      title: title ? title.innerText.trim() : null,
    });
  })()`);
  const after = JSON.parse(afterRaw || "{}");
  assert(!!after.source && after.source !== beforeSource, ".detail-source changed after 切换", JSON.stringify({ before: beforeSource, after: after.source }));
  assert(!!after.title, ".detail-title still non-empty", JSON.stringify(after.title));

  // 6. 详情页第一个 .episode → 播放页（播放器 + 信息卡 + 常驻选集）。
  const epClick = await cdp.eval(FIRST_CLICK(".episode"));
  assert(epClick === "CLICKED", "click first .episode to open player", epClick);
  if (epClick !== "CLICKED") {
    console.log(`[diag] detail page text: ${String(await cdp.eval("document.body.innerText.slice(0, 800)"))}`);
    console.log(`[diag] exceptions: ${cdp.errors.slice(0, 5).join(" | ").slice(0, 1200)}`);
  }
  const aboutReady = await cdp.eval(
    WAIT("return document.querySelector('.player-about') ? 'OK' : null;", 30000),
  );
  assert(aboutReady === "OK", ".player-about rendered", String(aboutReady));
  // 换源图标是 ArtPlayer 播放实例就绪后才 push 的（usePlayerEngine 与
  // 下一集/刷新同批），刚挂的 .player-about 读一帧常拿空数组——与
  // probe_player_nav 同口径改为轮询，而不是单帧读假红。
  // 换源图标随播放页新布局移进了选集面板头部（EpisodePanel section-head，
  // 「N 条线路 · 当前线路 M 集」右侧），不在 .player-about 里——探针锚点
  // 与 UI 同步（2026-11-20 实测漂移：.player-about 里查 换源 恒为空数组）。
  // 慢源（py 源解析 + level-4 嗅探 15s/次）可能让选集面板 30s 后才挂出，
  // 等待窗给 60s。
  const episodesReady = await waitEval(
    cdp,
    "return document.querySelector('.player-episodes .episode') && document.querySelector('.player-episodes .section-head button[aria-label=\"换源\"]') ? 'OK' : null;",
    60000,
  );
  assert(episodesReady === "OK", "选集面板常驻且换源图标在面板头部", String(episodesReady));
  const panelRaw = await cdp.eval(`(() => {
    const panel = document.querySelector('.player-episodes');
    if (!panel) return null;
    return JSON.stringify({
      chips: panel.querySelectorAll('.chip').length,
      episodes: panel.querySelectorAll('.episode').length,
      active: panel.querySelectorAll('.episode.is-active').length,
    });
  })()`);
  const panel = JSON.parse(panelRaw || "{}");
  assert(panel.episodes > 0, ".player-episodes .episode count > 0", JSON.stringify(panel));
  assert(panel.chips > 0, ".player-episodes .chip lines present", JSON.stringify(panel));
  assert(panel.active > 0, ".player-episodes current .episode.is-active present", JSON.stringify(panel));
  await cdp.shot("player-episodes");

  // 7. 选集面板头部换源图标 → picker 出现 → 关闭图标。
  const openFromPlayer = await cdp.eval(CLICK("换源", ".player-episodes .section-head button"));
  assert(openFromPlayer === "CLICKED", "open source-picker from episode panel head", openFromPlayer);
  const pickerFromPlayer = await cdp.eval(
    WAIT("return document.querySelector('.source-picker') ? 'OPEN' : null;", 10000),
  );
  assert(pickerFromPlayer === "OPEN", ".source-picker opened on player page", String(pickerFromPlayer));
  const closeIt = await cdp.eval(CLICK("关闭", ".source-picker button"));
  assert(closeIt === "CLICKED", "click close icon button", String(closeIt));
  const closedByX = await cdp.eval(
    WAIT("return document.querySelector('.source-picker') ? null : 'CLOSED';", 10000),
  );
  assert(closedByX === "CLOSED", ".source-picker closed by close icon", String(closedByX));
} catch (err) {
  console.log(`[diag] unexpected error: ${String((err && err.stack) || err)}`);
  try {
    console.log(`[diag] page text: ${String(await cdp.eval("document.body.innerText.slice(0, 800)"))}`);
  } catch {
    /* ignore diagnostic failure */
  }
  console.log(`[diag] exceptions: ${cdp.errors.slice(0, 5).join(" | ").slice(0, 1200)}`);
  failures += 1;
}

// 8. 未捕获页面异常为 0。
assert(cdp.errors.length === 0, "no uncaught page exceptions", cdp.errors.slice(0, 3).join(" | ").slice(0, 600));

cdp.close();
console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed step(s)`);
process.exit(failures === 0 ? 0 : 1);
