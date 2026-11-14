#!/usr/bin/env node
/**
 * S2/S3 验收：等待态（骨架/进度/取消）与首页 SiteSelect、直播分组折行。
 * 前置：Vite 1420 + debug 窗口（CDP 9222）。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const outDir = ".workbuddy/ui-audit";
mkdirSync(outDir, { recursive: true });
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find(
  (t) => t.type === "page" && t.webSocketDebuggerUrl && /^http:\/\/localhost:1420\/$/.test(t.url),
);
if (!page) {
  console.error("no app page:", list.map((t) => t.url).join(" | "));
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pend = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m.result);
    pend.delete(m.id);
  }
});
const cmd = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq;
    pend.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expression) =>
  (await cmd("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await cmd("Page.enable");
await cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(500);

// 等应用挂载
for (let i = 0; i < 40; i++) {
  if (await ev(`document.querySelectorAll('.nav__item').length > 0`)) break;
  await sleep(500);
}
const shot = async (name) => {
  const r = await cmd("Page.captureScreenshot", { format: "png" });
  writeFileSync(resolve(outDir, `${name}.png`), Buffer.from(r.data, "base64"));
  console.log(`  [shot] ${name}.png`);
};
const nav = (label) =>
  ev(`(() => {
    const el = [...document.querySelectorAll('.nav__item')].find(n => (n.getAttribute('aria-label')||n.textContent||'').trim() === ${JSON.stringify(label)});
    if (!el) return false; el.click(); return true;
  })()`);

const out = {};

// ---------- 1. 搜索等待态：骨架 + 进度 + 取消 ----------
console.log("\n== S2 搜索等待态 ==");
await nav("搜索");
for (let i = 0; i < 20; i++) {
  if (await ev(`!!document.querySelector('.search-bar')`)) break;
  await sleep(300);
}
await sleep(800);
await ev(`(() => {
  const i = document.querySelector('.search-bar input');
  if (!i) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(i, '庆余年');
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await ev(`[...document.querySelectorAll('.search-bar button')].find(b => (b.textContent||'').includes('搜索'))?.click()`);
await sleep(1500);
out.waitingState = await ev(`({
  skeleton: document.querySelectorAll('.sk-card').length,
  progress: !!document.querySelector('.search-progress'),
  progressLabel: document.querySelector('.search-progress__label')?.textContent || '',
  cancelBtn: !!document.querySelector('.search-progress button'),
  oldSpinner: !!document.querySelector('.spinner--center')
})`);
await shot("60-search-skeleton");

// 取消：点击后立即退出等待态
out.cancel = await ev(`(() => {
  const btn = [...document.querySelectorAll('.search-progress button')].find(b => b.textContent.includes('取消'));
  if (!btn) return 'NO_BTN';
  btn.click();
  return 'OK';
})()`);
await sleep(700);
out.afterCancel = await ev(`({
  skeleton: document.querySelectorAll('.sk-card').length,
  progress: !!document.querySelector('.search-progress'),
  loading: !!document.querySelector('.spinner--center')
})`);

// 重新搜一次等结果，验证骨架→结果无残留
await ev(`[...document.querySelectorAll('.search-bar button')].find(b => (b.textContent||'').includes('搜索'))?.click()`);
let cards = 0;
for (let i = 0; i < 30; i++) {
  await sleep(2000);
  const st = await ev(`({ sk: document.querySelectorAll('.sk-card').length, cards: document.querySelectorAll('.vod-card').length, prog: !!document.querySelector('.search-progress') })`);
  if (st && st.cards > 0 && !st.prog) { cards = st.cards; break; }
}
out.searchDone = { cards, skeletonLeftover: await ev(`document.querySelectorAll('.sk-card').length`) };
await sleep(4000);
await shot("61-search-results");

// ---------- 2. S3 首页 SiteSelect ----------
console.log("\n== S3 首页 SiteSelect ==");
await nav("首页");
for (let i = 0; i < 25; i++) {
  await sleep(500);
  if (await ev(`!!document.querySelector('.site-select__trigger')`)) break;
}
out.homeSelect = await ev(`({
  trigger: !!document.querySelector('.site-select__trigger'),
  value: document.querySelector('.site-select')?.getAttribute('data-value') || null,
  nativeSelectGone: !document.querySelector('select.select'),
  label: document.querySelector('.site-select__trigger')?.getAttribute('aria-label') || ''
})`);
await ev(`document.querySelector('.site-select__trigger')?.click()`);
await sleep(500);
out.menu = await ev(`({
  items: document.querySelectorAll('.site-select__item').length,
  disabled: document.querySelectorAll('.site-select__item.is-disabled').length,
  withDataKey: document.querySelectorAll('.site-select__item[data-key]').length
})`);
await shot("62-home-siteselect");
await ev(`document.body.click()`);
await sleep(300);

// ---------- 3. 直播分组折行 ----------
console.log("\n== S3 直播分组 ==");
await nav("直播");
await sleep(3500);
out.liveGroups = await ev(`(() => {
  const bar = document.querySelector('.group-tabs');
  if (!bar) return { exists: false };
  const r = bar.getBoundingClientRect();
  const chips = [...bar.querySelectorAll('.chip')];
  const lastRight = chips.length ? Math.max(...chips.map(c => c.getBoundingClientRect().right)) : 0;
  return {
    exists: true,
    chipCount: chips.length,
    barWidth: Math.round(r.width),
    barScrollW: bar.scrollWidth,
    lastChipRight: Math.round(lastRight),
    vw: innerWidth,
    wraps: bar.scrollHeight > 60
  };
})()`);
await shot("63-live-groups");

console.log("\n" + JSON.stringify(out, null, 2));
writeFileSync(resolve(outDir, "report-s2s3.json"), JSON.stringify(out, null, 2));
ws.close();
