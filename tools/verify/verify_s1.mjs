#!/usr/bin/env node
/** S1 终验：真实缓存（不禁缓存）下的用户实际体验。 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CDP = "http://127.0.0.1:9222/json/list";
const outDir = resolve("tools/.out/ui-audit");
const list = await (await fetch(CDP)).json();
const page = list.find((t) => {
  try { const u = new URL(t.url); return u.port === "1420" && (u.pathname === "/" || u.pathname === ""); }
  catch { return false; }
});
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
});
const cmd = (method, params = {}) => new Promise((res) => {
  const i = ++id; pend.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pend.has(i)) pend.delete(i); }, 150000);
});
const ev = async (x) => (await cmd("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }))?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nav = (label) => ev(`(() => {
  const el = [...document.querySelectorAll('.nav__item')].find(n => (n.getAttribute('aria-label')||n.textContent||'').trim() === ${JSON.stringify(label)});
  if (!el) return false; el.click(); return true;
})()`);
async function shot(name) {
  await cmd("Page.enable");
  const r = await cmd("Page.captureScreenshot", { format: "png" });
  writeFileSync(resolve(outDir, `${name}.png`), Buffer.from(r.data, "base64"));
  console.log(`  [shot] ${name}.png`);
}

await cmd("Page.enable");
await cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
// 真实缓存：不禁用，代理侧 cache-control 7 天生效
await cmd("Network.enable");
await cmd("Network.setCacheDisabled", { cacheDisabled: false });
await cmd("Page.reload", { ignoreCache: false });
for (let i = 0; i < 60; i++) {
  if (await ev(`document.querySelectorAll('.nav__item').length > 0`)) break;
  await sleep(500);
}
await sleep(1500);

console.log("=== 首页（缓存热）===");
await nav("首页");
await sleep(6000);
await shot("60-home");
const home = await ev(`(() => {
  const imgs = [...document.querySelectorAll('.vod-card__poster img')];
  return {
    cards: document.querySelectorAll('.vod-card').length,
    loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
    skeleton: document.querySelectorAll('.vod-card__skeleton').length,
    failed: document.querySelectorAll('.vod-card__ph--failed').length,
  };
})()`);
console.log("  ", JSON.stringify(home));

console.log("\n=== 搜索（缓存热：代理有 7 天 cache-control）===");
await nav("搜索");
await sleep(2500);
await ev(`(() => { const i = document.querySelector('.search-bar input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(i, '庆余年'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await sleep(600);
await ev(`[...document.querySelectorAll('.search-bar button')].find(b => (b.textContent||'').includes('搜索'))?.click()`);
for (let i = 0; i < 70; i++) {
  await sleep(2000);
  const s = await ev(`({ l: !!document.querySelector('.search-progress'), c: document.querySelectorAll('.vod-card').length })`);
  if (s && !s.l && s.c > 100) break;
}
await sleep(1200);
await shot("61-search-early");
const early = await ev(`(() => {
  const imgs = [...document.querySelectorAll('.vod-card__poster img')];
  const cards = [...document.querySelectorAll('.vod-card')];
  const vis = cards.filter(c => { const r = c.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; });
  const vi = vis.map(c => c.querySelector('img')).filter(Boolean);
  return {
    cards: cards.length,
    skeleton: document.querySelectorAll('.vod-card__skeleton').length,
    failed: document.querySelectorAll('.vod-card__ph--failed').length,
    allLoaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
    vis: vis.length, visLoaded: vi.filter(i => i.complete && i.naturalWidth > 0).length,
  };
})()`);
console.log("  1.2s 后:", JSON.stringify(early));

await sleep(10000);
await shot("62-search-settled");
const settled = await ev(`(() => {
  const imgs = [...document.querySelectorAll('.vod-card__poster img')];
  const cards = [...document.querySelectorAll('.vod-card')];
  const vis = cards.filter(c => { const r = c.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; });
  const vi = vis.map(c => c.querySelector('img')).filter(Boolean);
  return {
    allLoaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
    allTotal: imgs.length,
    skeleton: document.querySelectorAll('.vod-card__skeleton').length,
    failed: document.querySelectorAll('.vod-card__ph--failed').length,
    vis: vis.length, visLoaded: vi.filter(i => i.complete && i.naturalWidth > 0).length,
  };
})()`);
console.log("  11s 后:", JSON.stringify(settled));

// 滚一遍看视口加载
console.log("\n  滚动各屏视口加载：");
for (const y of [1000, 4000, 8000]) {
  await ev(`document.querySelector('.content').scrollTop = ${y}`);
  await sleep(2500);
  const s = await ev(`(() => {
    const cards = [...document.querySelectorAll('.vod-card')];
    const vis = cards.filter(c => { const r = c.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; });
    const vi = vis.map(c => c.querySelector('img')).filter(Boolean);
    return { vis: vis.length, loaded: vi.filter(i => i.complete && i.naturalWidth > 0).length, skel: document.querySelectorAll('.vod-card__skeleton').length };
  })()`);
  console.log(`    scrollTop=${y}: ${s.loaded}/${s.vis} 已载, 全局骨架 ${s.skel}`);
}
await ev(`document.querySelector('.content').scrollTop = 0`);
await sleep(1500);
await shot("63-search-top");
ws.close();
