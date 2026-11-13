#!/usr/bin/env node
/**
 * UI/UX 走查：用 CDP 抓真实窗口的渲染结果（截图 + 几何量测），供设计评审取证。
 *
 * 与既有探针的区别：那些断言「功能对不对」，这个只回答「长什么样、有多挤、
 * 哪里看不见、能不能点得到」——输出既给人看，也给量测数据。
 *
 * 前置：dev 窗口在跑（CDP 127.0.0.1:9222）、Vite 在 1420。
 * 用法：node tools/audit_ui.mjs [--out=.workbuddy/ui-audit]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CDP = "http://127.0.0.1:9222/json/list";
const args = process.argv.slice(2);
const outDir = resolve(
  args.find((a) => a.startsWith("--out="))?.slice(6) || ".workbuddy/ui-audit",
);
mkdirSync(outDir, { recursive: true });

const list = await (await fetch(CDP)).json();
// 应用窗口是 devUrl 根路径（http://localhost:1420/）；CDP 里可能还有别的 target
// （如本地打开的 HTML 预览，其 URL 也含 1420），必须按「路径为空」精确认。
const page = list.find((t) => {
  if (t.type !== "page" || !t.webSocketDebuggerUrl) return false;
  try {
    const u = new URL(t.url);
    return u.port === "1420" && (u.pathname === "/" || u.pathname === "");
  } catch {
    return false;
  }
});
if (!page) {
  console.error(
    "no app page on 1420 (窗口没起?)；现有 target:",
    list.map((t) => t.url).join(" | "),
  );
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener("open", r, { once: true });
  ws.addEventListener("error", j, { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
});
function cmd(method, params = {}) {
  const id = ++seq;
  return new Promise((res) => {
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) pending.delete(id);
    }, 90000);
  });
}
async function ev(expression) {
  const r = await cmd("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return r?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(name) {
  await cmd("Page.enable");
  const r = await cmd("Page.captureScreenshot", { format: "png" });
  writeFileSync(resolve(outDir, `${name}.png`), Buffer.from(r.data, "base64"));
  console.log(`  [shot] ${name}.png`);
}

/** 应用可能还停在 Vite 依赖预构建的空白页——先确认 React 已挂载再开拍。 */
async function waitForBoot(timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await ev(`document.querySelectorAll('.nav__item').length > 0`)) return true;
    await sleep(500);
  }
  return false;
}
async function waitFor(sel, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await ev(`!!document.querySelector(${JSON.stringify(sel)})`)) return true;
    await sleep(250);
  }
  return false;
}
/** 点侧栏导航（按 aria-label 或文本）。 */
const nav = (label) =>
  ev(`(() => {
    const el = [...document.querySelectorAll('.nav__item')].find(n => (n.getAttribute('aria-label')||n.textContent||'').trim() === ${JSON.stringify(label)});
    if (!el) return false; el.click(); return true;
  })()`);

/**
 * 几何量测：找出所有溢出视口的元素、被裁切的文本、点击热区过小的控件。
 * 这些是「看起来还行、实际不好用」的典型来源。
 */
const MEASURE = `(() => {
  const out = { overflow: [], tinyTargets: [], clipped: [] };
  const vw = innerWidth, vh = innerHeight;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      out.overflow.push({ sel: el.className || el.tagName, left: Math.round(r.left), right: Math.round(r.right), vw });
    }
    if ((el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && (r.width < 24 || r.height < 24)) {
      out.tinyTargets.push({ sel: el.className || el.tagName, label: el.getAttribute('aria-label') || (el.textContent||'').trim().slice(0,20), w: Math.round(r.width), h: Math.round(r.height) });
    }
    if (el.children.length === 0 && (el.textContent||'').trim() && el.scrollWidth > el.clientWidth + 2 && cs.overflow === 'hidden' && cs.textOverflow !== 'ellipsis') {
      out.clipped.push({ sel: el.className || el.tagName, text: (el.textContent||'').trim().slice(0,30), sw: el.scrollWidth, cw: el.clientWidth });
    }
  }
  out.overflow = out.overflow.slice(0, 30);
  out.tinyTargets = out.tinyTargets.slice(0, 30);
  out.clipped = out.clipped.slice(0, 30);
  return out;
})()`;

const report = { viewport: {}, pages: {} };

// 固定视口到 1280x800（= 应用默认窗口宽高），保证多次走查截图可比。
await cmd("Page.enable");
await cmd("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(500);
report.viewport = await ev(`({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })`);
console.log("viewport:", JSON.stringify(report.viewport));

if (!(await waitForBoot())) {
  console.error("React 未挂载，reload 一次再试");
  await cmd("Page.reload", { ignoreCache: true });
  await waitForBoot();
}

// ---------- 1. 首页 ----------
console.log("\n== 首页 ==");
await nav("首页");
await sleep(3000);
await shot("01-home");
report.pages.home = await ev(MEASURE);
report.pages.homeMeta = await ev(`(() => {
  const cards = [...document.querySelectorAll('.vod-card')];
  const cs = document.querySelector('.vod-grid') ? getComputedStyle(document.querySelector('.vod-grid')) : null;
  const fr = cards[0]?.getBoundingClientRect();
  const imgs = [...document.querySelectorAll('.vod-card__poster img')];
  return {
    cardCount: cards.length,
    gridCols: cs?.gridTemplateColumns,
    cardW: fr ? Math.round(fr.width) : 0,
    chipCount: document.querySelectorAll('.chip-row .chip').length,
    posters: imgs.length,
    postersLoaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
    siteSelect: (() => { const s = document.querySelector('select.select'); if (!s) return null; const r = s.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), opts: s.options.length, appearance: getComputedStyle(s).appearance }; })()
  };
})()`);
console.log("  首页:", JSON.stringify(report.pages.homeMeta));

// 分类态
if (await ev(`document.querySelectorAll('.chip-row .chip').length > 1`)) {
  await ev(`document.querySelectorAll('.chip-row .chip')[1]?.click()`);
  await sleep(2500);
  await shot("02-home-category");
  report.pages.homeCategory = await ev(MEASURE);
  await ev(`document.querySelectorAll('.chip-row .chip')[0]?.click()`);
  await sleep(800);
}

// ---------- 2. 侧栏收缩态 ----------
console.log("\n== 侧栏收缩 ==");
await ev(`document.querySelector('.sidebar__collapse')?.click()`);
await sleep(900);
await shot("03-sidebar-collapsed");
report.pages.sidebarCollapsed = await ev(MEASURE);
await ev(`document.querySelector('.sidebar__collapse')?.click()`);
await sleep(700);

// ---------- 3. 搜索页 ----------
console.log("\n== 搜索页 ==");
await nav("搜索");
await waitFor(".search-bar");
await sleep(1200);
await shot("04-search-empty");
report.pages.searchEmpty = await ev(MEASURE);

// 聚合搜索：输入 → 提交 → 等真正结束（最久 90s）
await ev(`(() => {
  const i = document.querySelector('.search-bar input');
  if (!i) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(i, '庆余年');
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(600);
await shot("05-search-loading");
await ev(`[...document.querySelectorAll('.search-bar button')].find(b => (b.textContent||'').includes('搜索'))?.click()`);
await sleep(2500);
await shot("06-search-loading-2");

let searchState = null;
for (let i = 0; i < 45; i++) {
  await sleep(2000);
  searchState = await ev(`({
    loading: !!document.querySelector('.spinner--center'),
    cards: document.querySelectorAll('.vod-card').length,
    meta: (document.querySelector('.result-meta')?.textContent||'').slice(0,200),
    failRows: document.querySelectorAll('.failure-item').length
  })`);
  if (searchState && !searchState.loading) break;
}
console.log("  搜索:", JSON.stringify(searchState));
await sleep(6000); // 等图片解码
await shot("07-search-results");
report.pages.searchResults = await ev(MEASURE);
report.pages.searchMeta = searchState;
report.pages.covers = await ev(`(() => {
  const imgs = [...document.querySelectorAll('.vod-card__poster img')];
  return { total: imgs.length, loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
    broken: imgs.filter(i => i.complete && i.naturalWidth === 0).length };
})()`);
console.log("  封面:", JSON.stringify(report.pages.covers));

// ---------- 4. 详情页 ----------
console.log("\n== 详情页 ==");
if (await ev(`document.querySelectorAll('.vod-card').length > 0`)) {
  await ev(`document.querySelector('.vod-card').click()`);
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    if (await ev(`!!document.querySelector('.detail-title') || !!document.querySelector('.detail-empty')`)) break;
  }
  await sleep(1500);
  await shot("08-detail");
  report.pages.detail = await ev(MEASURE);
  report.pages.detailMeta = await ev(`({
    title: document.querySelector('.detail-title')?.textContent || '',
    empty: !!document.querySelector('.detail-empty'),
    lines: [...document.querySelectorAll('.section .chip-row .chip')].map(c=>c.textContent.trim()),
    episodes: document.querySelectorAll('.episode').length
  })`);
  console.log("  详情:", JSON.stringify(report.pages.detailMeta));

  await ev(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '换源')?.click()`);
  await sleep(3000);
  await shot("09-source-picker");
  report.pages.sourcePicker = await ev(MEASURE);
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(700);
}

// ---------- 5. 播放页 ----------
console.log("\n== 播放页 ==");
const played = await ev(`(() => {
  const btn = [...document.querySelectorAll('button.btn--primary')].find(b => (b.textContent||'').includes('播放'));
  if (!btn) return false; btn.click(); return true;
})()`);
console.log("  点播放:", played);
if (played) {
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const st = await ev(`({ v: !!document.querySelector('video'), o: !!document.querySelector('.player-overlay'), e: document.querySelector('.error-bar')?.textContent || '' })`);
    if (st && st.v && !st.o) break;
    if (st && st.e) break;
  }
  await sleep(5000);
  await shot("10-player");
  report.pages.player = await ev(MEASURE);
  report.pages.playerMeta = await ev(`({
    hasVideo: !!document.querySelector('video'),
    vw: document.querySelector('video')?.videoWidth || 0,
    vh: document.querySelector('video')?.videoHeight || 0,
    overlay: !!document.querySelector('.player-overlay'),
    errorBar: document.querySelector('.error-bar')?.textContent || '',
    stage: (() => { const s = document.querySelector('.player-stage'); if (!s) return null; const r = s.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
    episodes: document.querySelectorAll('.episode').length,
    res: document.querySelector('.player-res')?.textContent || ''
  })`);
  console.log("  播放:", JSON.stringify(report.pages.playerMeta));
}

// ---------- 6. 设置页 ----------
console.log("\n== 设置页 ==");
await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
await sleep(800);
await nav("设置");
await waitFor(".settings-block");
await sleep(2000);
await shot("11-settings");
report.pages.settings = await ev(MEASURE);
report.pages.settingsMeta = await ev(`({
  blocks: document.querySelectorAll('.settings-block').length,
  pageHeight: document.querySelector('.content')?.scrollHeight || 0,
  viewport: innerHeight
})`);
console.log("  设置:", JSON.stringify(report.pages.settingsMeta));

// ---------- 7. 直播页 ----------
console.log("\n== 直播页 ==");
await nav("直播");
await sleep(3500);
await shot("12-live");
report.pages.live = await ev(MEASURE);
report.pages.liveMeta = await ev(`({
  chips: document.querySelectorAll('.chip').length,
  groups: document.querySelectorAll('.group-tabs [role=tab]').length,
  logoImgs: document.querySelectorAll('.channel-logo').length,
  brokenLogo: [...document.querySelectorAll('.channel-logo')].filter(i => i.complete && i.naturalWidth === 0).length
})`);
console.log("  直播:", JSON.stringify(report.pages.liveMeta));

// ---------- 8. 收藏 / 历史 ----------
await nav("收藏");
await sleep(1500);
await shot("13-favorites");
await nav("历史");
await sleep(1500);
await shot("14-history");

// ---------- 9. 键盘可达性 ----------
console.log("\n== 键盘可达性 ==");
await nav("首页");
await sleep(2000);
report.pages.keyboard = await ev(`(() => {
  const focusables = [...document.querySelectorAll('a[href], button:not([disabled]), input, select, [tabindex]:not([tabindex="-1"])')]
    .filter(el => el.offsetParent !== null);
  const sidebarBtns = focusables.filter(el => el.closest('.sidebar')).length;
  const firstContent = focusables.findIndex(el => el.closest('.content'));
  const small = focusables.filter(e => { const r = e.getBoundingClientRect(); return r.width < 32 || r.height < 32; })
    .map(e => { const r = e.getBoundingClientRect(); return { cls: e.className||e.tagName, label: e.getAttribute('aria-label')||(e.textContent||'').trim().slice(0,14), w: Math.round(r.width), h: Math.round(r.height) }; });
  return {
    focusableTotal: focusables.length,
    sidebarFocusables: sidebarBtns,
    firstContentIndex: firstContent,
    ariaLiveRegions: document.querySelectorAll('[aria-live]').length,
    roleDialog: document.querySelectorAll('[role=dialog],[role=alertdialog]').length,
    roleListbox: document.querySelectorAll('[role=listbox]').length,
    tinyTargets: small,
    buttonsWithoutLabel: [...document.querySelectorAll('button')].filter(b => !(b.textContent||'').trim() && !b.getAttribute('aria-label') && !b.getAttribute('title')).length,
    imgsWithoutAlt: [...document.querySelectorAll('img')].filter(i => !i.hasAttribute('alt')).length
  };
})()`);
console.log("  键盘:", JSON.stringify(report.pages.keyboard));

// Tab 后焦点环
await ev(`document.body.focus()`);
for (let i = 0; i < 9; i++) {
  await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await sleep(120);
}
report.pages.focusRing = await ev(`(() => {
  const el = document.activeElement; if (!el) return null;
  const cs = getComputedStyle(el);
  return { tag: el.tagName, cls: el.className, outline: cs.outline, outlineOffset: cs.outlineOffset };
})()`);
console.log("  焦点环:", JSON.stringify(report.pages.focusRing));
await shot("15-focus-ring");

writeFileSync(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));
console.log("\n报告写入:", resolve(outDir, "report.json"));
ws.close();
