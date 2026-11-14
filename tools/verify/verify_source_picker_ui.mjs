#!/usr/bin/env node
/**
 * 换源面板交互/尺寸验收（真实源）：
 *  1. 打开即聚焦搜索框并全选（焦点不再落在关闭按钮上、不弹「关闭」气泡）；
 *  2. 搜索行控件同高（38），候选行同高（60）——备注长短不影响行高；
 *  3. 统计行单行不折行；
 *  4. 点行内空白（头像）＝点「切换」，面板关闭且详情仍在；
 *  5. 换一个源再点「切换」按钮，同样生效（DOM 契约路径）。
 *
 * 用法：node tools/verify/verify_source_picker_ui.mjs
 */
const target = (await (await fetch("http://127.0.0.1:9222/json/list")).json()).find((t) => {
  try {
    const u = new URL(t.url);
    return t.type === "page" && u.port === "1420";
  } catch {
    return false;
  }
});
if (!target) throw new Error("app target not found");

const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
const ready = new Promise((r, j) => {
  ws.addEventListener("open", r, { once: true });
  ws.addEventListener("error", j, { once: true });
});
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
async function send(method, params = {}) {
  await ready;
  const id = ++seq;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${method} timeout`)), 120000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      res(m);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  return r.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(expr, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluate(expr)) return true;
    await sleep(250);
  }
  return false;
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
}

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});

// 回首页 → 进详情
await evaluate("location.hash = '#/'");
await sleep(1500);
await evaluate(`(() => {
  const card = document.querySelector('.vod-card a, .vod-card');
  if (!card) return 'no-card';
  (card.closest('a') || card).click();
  return 'ok';
})()`);
await sleep(2200);

async function openPicker() {
  const r = await evaluate(`(() => {
    const btn = document.querySelector('[aria-label="换源"]');
    if (!btn) return 'no-swap';
    btn.click();
    return 'ok';
  })()`);
  if (r !== "ok") throw new Error("换源入口未找到");
  const opened = await waitFor("!!document.querySelector('.source-picker')", 5000);
  if (!opened) throw new Error("面板未打开");
  await waitFor("document.querySelectorAll('.source-item').length >= 2", 35000);
  await sleep(400);
}

// ---- 1. 首次打开：焦点与全选 ----
await openPicker();
const focus = await evaluate(`(() => {
  const el = document.activeElement;
  const isInput = el && el.matches('.source-picker__search input.input');
  return {
    isInput,
    active: el ? el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ')[0] : null,
    selection: isInput ? [el.selectionStart, el.selectionEnd, el.value.length] : null,
    tipVisible: (() => {
      const b = document.querySelector('.source-picker [aria-label="关闭"]');
      if (!b) return null;
      return getComputedStyle(b, '::after').opacity;
    })(),
  };
})()`);
check("打开即聚焦搜索框", focus.isInput === true, JSON.stringify(focus.active));
check(
  "关键词被全选（键入即替换）",
  !!focus.selection && focus.selection[0] === 0 && focus.selection[1] === focus.selection[2],
  JSON.stringify(focus.selection),
);
check("关闭按钮不再弹提示气泡", focus.tipVisible === "0", `::after opacity=${focus.tipVisible}`);

// ---- 2. 尺寸一致性 + DOM 契约 ----
const sizes = await evaluate(`(() => {
  const h = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null);
  const w = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null);
  const items = [...document.querySelectorAll('.source-item')];
  const kids = [...document.querySelectorAll('.source-picker__search > *')];
  const cb = document.querySelector('.source-picker .filter-toggle input');
  const meta = document.querySelector('.source-picker__meta');
  const first = items[0];
  return {
    controls: kids.map((el) => ({ cls: String(el.className).split(' ')[0], h: h(el) })),
    rows: items.map(h),
    picks: items.map((el) => {
      const b = el.querySelector('.source-item__pick');
      return { w: w(b), h: h(b) };
    }),
    metaH: h(meta),
    metaKidsTop: [...document.querySelectorAll('.source-picker__meta > *')].map((el) =>
      Math.round(el.getBoundingClientRect().top),
    ),
    metaText: meta ? meta.innerText.trim() : null,
    metaStatsScroll: (() => {
      const t = document.querySelector('.source-picker__stats-text');
      return t ? { scroll: t.scrollWidth, client: t.clientWidth, text: t.textContent } : null;
    })(),
    searchW: kids.map(w),
    contract: {
      searchInput: !!document.querySelector('.source-picker__search input.input'),
      filterChecked: cb ? cb.checked : null,
      firstSite: !!first?.querySelector('.source-item__site'),
      firstTitle: !!first?.querySelector('.source-item__title'),
      firstSwitch: !!first && [...first.querySelectorAll('button')].some((b) => (b.textContent || '').includes('切换')),
      cacheBadge: !!document.querySelector('.source-cache-badge'),
      noSpinner: !document.querySelector('.source-picker .spinner'),
    },
  };
})()`);
const controlHeights = new Set(sizes.controls.map((c) => c.h));
check(
  "搜索行控件同高",
  controlHeights.size === 1,
  sizes.controls.map((c) => `${c.cls}:${c.h}`).join(" / "),
);
const rowHeights = new Set(sizes.rows);
check("候选行行高一致", rowHeights.size === 1, `heights=${[...rowHeights].join(",")} ×${sizes.rows.length}`);
const pickSizes = new Set(sizes.picks.map((p) => `${p.w}x${p.h}`));
check("切换按钮尺寸一致", pickSizes.size === 1, [...pickSizes].join(" | "));
check(
  "统计行单行（与「只看片名匹配」同基线）",
  sizes.metaKidsTop.length === 2 && Math.abs(sizes.metaKidsTop[0] - sizes.metaKidsTop[1]) <= 4,
  `tops=${sizes.metaKidsTop.join(",")} metaH=${sizes.metaH}`,
);
check(
  "统计文本未被截断",
  !!sizes.metaStatsScroll && sizes.metaStatsScroll.scroll <= sizes.metaStatsScroll.client + 1,
  sizes.metaStatsScroll
    ? `${sizes.metaStatsScroll.scroll}/${sizes.metaStatsScroll.client} 「${sizes.metaStatsScroll.text}」`
    : "missing",
);

// DOM 契约（probe_source_picker / probe_source_cache 依赖，改了会红）
const c = sizes.contract;
check("契约：__search input.input", c.searchInput === true);
check("契约：filter-toggle 默认勾选", c.filterChecked === true, String(c.filterChecked));
check("契约：__meta 含「个站点」", !!sizes.metaText && sizes.metaText.includes("个站点"), sizes.metaText);
check("契约：行内 __site / __title / 切换按钮", c.firstSite && c.firstTitle && c.firstSwitch, JSON.stringify(c));
check("契约：缓存徽章存在、命中时不出现 spinner", c.cacheBadge && c.noSpinner, JSON.stringify({ badge: c.cacheBadge, noSpinner: c.noSpinner }));

// ---- 3. 整行可点：点头像空白处应等于切换 ----
const rowClick = await evaluate(`(() => {
  const row = document.querySelector('.source-item');
  if (!row) return 'NO_ROW';
  const avatar = row.querySelector('.source-item__avatar');
  avatar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return 'CLICKED';
})()`);
check("点击行内空白触发切换", rowClick === "CLICKED", rowClick);
const closedByRow = await waitFor("!document.querySelector('.source-picker')", 30000);
check("整行点击后面板关闭（切换已发生）", closedByRow === true);
const stillDetail = await evaluate("!!document.querySelector('.detail-title')");
check("切换后仍在详情页", stillDetail === true);

// ---- 4. 按钮路径仍然可用 ----
await openPicker();
const btnClick = await evaluate(`(() => {
  const btn = document.querySelector('.source-item .source-item__pick');
  if (!btn) return 'NO_BTN';
  btn.click();
  return 'CLICKED';
})()`);
check("切换按钮可点", btnClick === "CLICKED", btnClick);
const closedByBtn = await waitFor("!document.querySelector('.source-picker')", 30000);
check("按钮点击后面板关闭", closedByBtn === true);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
ws.close();
if (failed.length > 0) {
  process.exitCode = 1;
}
