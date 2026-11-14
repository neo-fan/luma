#!/usr/bin/env node
/**
 * 定位真正的根因：图片到底是「网络慢」还是「被 lazy 判定挡住」？
 * 关键观测：/image 本地代理是否成为瓶颈（串行排队？）。
 */
const CDP = "http://127.0.0.1:9222/json/list";
const list = await (await fetch(CDP)).json();
const page = list.find((t) => {
  try { const u = new URL(t.url); return u.port === "1420" && (u.pathname === "/" || u.pathname === ""); }
  catch { return false; }
});
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pend = new Map(); const netEvents = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  else if (m.method && m.method.startsWith("Network.")) netEvents.push(m);
});
const cmd = (method, params = {}) => new Promise((res) => {
  const i = ++id; pend.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pend.has(i)) pend.delete(i); }, 180000);
});
const ev = async (x) => (await cmd("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }))?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nav = (label) => ev(`(() => {
  const el = [...document.querySelectorAll('.nav__item')].find(n => (n.getAttribute('aria-label')||n.textContent||'').trim() === ${JSON.stringify(label)});
  if (!el) return false; el.click(); return true;
})()`);

// 让代理缓存生效（不禁用浏览器缓存，模拟真实使用：第二次访问图很快）
await cmd("Network.enable");
await cmd("Page.enable");
await cmd("Page.reload", { ignoreCache: false });
for (let i = 0; i < 60; i++) {
  if (await ev(`document.querySelectorAll('.nav__item').length > 0`)) break;
  await sleep(500);
}
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
await sleep(3000);

// 采集网络：/image 请求的并发与耗时
netEvents.length = 0;
await ev(`document.querySelector('.content').scrollTop = 0`);
await sleep(1000);
const t0 = Date.now();
await ev(`document.querySelector('.content').scrollTop = 1500`);
await sleep(12000);
const elapsed = Date.now() - t0;

const imgs = netEvents.filter((e) => e.method === "Network.requestWillBeSent" && e.params.request.url.includes("/image"));
const fins = netEvents.filter((e) => e.method === "Network.loadingFinished" && imgs.some(i => i.params.requestId === e.params.requestId));
const fails = netEvents.filter((e) => e.method === "Network.loadingFailed");
const resp = netEvents.filter((e) => e.method === "Network.responseReceived" && e.params.response.url.includes("/image"));

// 统计同一时刻在飞的 /image 请求数（并发度）
const timeline = [];
for (const e of netEvents) {
  if (!e.params.request?.url?.includes("/image")) continue;
  if (e.method === "Network.requestWillBeSent") timeline.push({ t: e.params.timestamp, s: 1 });
  if (e.method === "Network.loadingFinished" || e.method === "Network.loadingFailed") timeline.push({ t: e.params.timestamp, s: -1 });
}
timeline.sort((a, b) => a.t - b.t);
let cur = 0, maxConc = 0;
for (const ev2 of timeline) { cur += ev2.s; maxConc = Math.max(maxConc, cur); }

const durs = fins.map((f) => {
  const req = imgs.find((i) => i.params.requestId === f.params.requestId);
  return req ? Math.round((f.params.timestamp - req.params.timestamp) * 1000) : null;
}).filter((d) => d !== null).sort((a, b) => a - b);

console.log("=== /image 网络观测（12s 滚动窗口）===");
console.log("  /image 请求发起:", imgs.length);
console.log("  /image 完成:", fins.length, " 失败:", fails.length);
console.log("  最大并发:", maxConc);
console.log("  耗时 ms: min=" + (durs[0] ?? '-') + " p50=" + (durs[Math.floor(durs.length/2)] ?? '-') + " p90=" + (durs[Math.floor(durs.length*0.9)] ?? '-') + " max=" + (durs[durs.length-1] ?? '-'));
console.log("  观察窗口:", elapsed, "ms");

const st = await ev(`(() => {
  const imgs2 = [...document.querySelectorAll('.vod-card__poster img')];
  const cards = [...document.querySelectorAll('.vod-card')];
  const vis = cards.filter(c => { const r = c.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; });
  const vi = vis.map(c => c.querySelector('img')).filter(Boolean);
  return {
    total: imgs2.length,
    loaded: imgs2.filter(i => i.complete && i.naturalWidth > 0).length,
    vis: vis.length, visLoaded: vi.filter(i => i.complete && i.naturalWidth > 0).length,
    srcHost: imgs2.slice(0,1).map(i => i.src.slice(0,60)),
  };
})()`);
console.log("  状态:", JSON.stringify(st));

// 直接测代理吞吐：并发请求 10 张图
const bench = await ev(`(async () => {
  const imgs = [...document.querySelectorAll('.vod-card__poster img')].slice(0, 10);
  const t = performance.now();
  await Promise.all(imgs.map(i => i.decode().catch(() => {})));
  return { ms: Math.round(performance.now() - t), n: imgs.length };
})()`);
console.log("  并发 decode 10 张:", JSON.stringify(bench));
ws.close();
