#!/usr/bin/env node
/**
 * 直播播放页布局验收（真实源）：
 *  1. 左「换台」目录与右「画面 + 节目单」两栏就位，画面明显比旧版小；
 *  2. 目录里当前频道高亮且自动滚到视野内；
 *  3. 节目单默认滚到「正在播出」那条；
 *  4. 点目录里另一个频道能换台（vodId/画面都变），不是只改高亮。
 *
 * 用法：node tools/probe_live_layout.mjs [频道名] [目标频道名]
 */
import { writeFileSync, mkdirSync } from "node:fs";

const FIRST = process.argv[2] || "";
const SECOND = process.argv[3] || "";
const OUT = ".workbuddy";
mkdirSync(OUT, { recursive: true });

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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
}
await send("Runtime.enable");
await send("Page.enable");

const picked = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(300); } return null; };
  location.hash = '#/live';
  // 直播页现在直接就是播放页：列表在左栏，频道项是 .live-rail__item。
  const items = await waitFor(() => {
    const list = [...document.querySelectorAll('.live-rail__item')];
    return list.length > 0 ? list : null;
  }, 60000);
  if (!items) return { ok: false, reason: 'NO_RAIL_ITEM', body: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200) };
  const wanted = ${JSON.stringify(FIRST)};
  const item = wanted
    ? items.find((i) => i.textContent.includes(wanted))
    : items.find((i) => i.classList.contains('is-active')) || items[0];
  if (!item) return { ok: false, reason: 'NO_MATCH', sample: items.slice(0, 8).map((i) => i.textContent.trim()) };
  const name = item.querySelector('.live-rail__name')?.textContent || item.textContent.trim();
  if (!item.classList.contains('is-active')) {
    item.click();
  }
  await sleep(800);
  return { ok: true, name, railItems: items.length, hash: location.hash };
})()`);
console.log("[pick]", JSON.stringify(picked));

// 等出画（直播首帧通常在 10s 内，多给一点）
let state = null;
for (let i = 0; i < 15; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  state = await evaluate(`(() => {
    const rail = document.querySelector('.live-rail');
    const stage = document.querySelector('.player-stage');
    const epg = document.querySelector('.live-epg');
    const video = document.querySelector('.player-art video');
    const items = [...document.querySelectorAll('.live-rail__item')];
    const active = document.querySelector('.live-rail__item.is-active');
    const railBox = rail?.getBoundingClientRect();
    const stageBox = stage?.getBoundingClientRect();
    const epgBox = epg?.getBoundingClientRect();
    const list = document.querySelector('.epg-list');
    const nowItem = document.querySelector('.epg-item.is-now');
    return {
      hash: location.hash,
      rail: railBox ? { x: Math.round(railBox.x), w: Math.round(railBox.width), h: Math.round(railBox.height), items: items.length } : null,
      stage: stageBox ? { x: Math.round(stageBox.x), y: Math.round(stageBox.y), w: Math.round(stageBox.width), h: Math.round(stageBox.height) } : null,
      epg: epgBox ? { x: Math.round(epgBox.x), w: Math.round(epgBox.width) } : null,
      activeItem: active?.textContent?.trim() || null,
      activeVisible: (() => {
        if (!active || !rail) return null;
        const s = document.querySelector('.live-rail__scroll');
        const b = s.getBoundingClientRect();
        const i = active.getBoundingClientRect();
        return i.top >= b.top - 1 && i.bottom <= b.bottom + 1;
      })(),
      epgNowInView: (() => {
        if (!list || !nowItem) return null;
        const b = list.getBoundingClientRect();
        const i = nowItem.getBoundingClientRect();
        return i.top >= b.top - 1 && i.bottom <= b.bottom + 1;
      })(),
      epgScrollTop: list ? Math.round(list.scrollTop) : null,
      video: video ? { w: video.videoWidth, h: video.videoHeight, t: +video.currentTime.toFixed(1), err: video.error?.code || 0 } : null,
      stageText: document.querySelector('.player-status__title')?.textContent || '',
    };
  })()`);
  console.log(`[t+${(i + 1) * 2}s]`, JSON.stringify(state));
  if (state?.video?.w > 0) break;
}

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${OUT}/live-player-layout.png`, Buffer.from(shot.result.data, "base64"));
console.log("[shot]", `${OUT}/live-player-layout.png`);

// 换台：点目录里第一个非当前频道
const switched = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wanted = ${JSON.stringify(SECOND)};
  const items = [...document.querySelectorAll('.live-rail__item')];
  const pool = wanted ? items.filter((i) => i.textContent.includes(wanted)) : items;
  const next = pool.find((i) => !i.classList.contains('is-active'));
  if (!next) return { ok: false, reason: 'NO_OTHER_CHANNEL' };
  const name = next.querySelector('.live-rail__name')?.textContent || next.textContent;
  next.click();
  await sleep(1200);
  return {
    ok: true,
    name,
    hash: location.hash,
    active: document.querySelector('.live-rail__item.is-active')?.querySelector('.live-rail__name')?.textContent || null,
    bar: document.querySelector('.live-bar__title')?.textContent || '',
  };
})()`);
console.log("[switch]", JSON.stringify(switched));

for (let i = 0; i < 12; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  const after = await evaluate(`(() => {
    const video = document.querySelector('.player-art video');
    return {
      hash: location.hash,
      bar: document.querySelector('.live-bar__title')?.textContent || '',
      active: document.querySelector('.live-rail__item.is-active')?.querySelector('.live-rail__name')?.textContent || null,
      video: video ? { w: video.videoWidth, t: +video.currentTime.toFixed(1), err: video.error?.code || 0 } : null,
      stageText: document.querySelector('.player-status__title')?.textContent || '',
    };
  })()`);
  console.log(`[switch t+${(i + 1) * 2}s]`, JSON.stringify(after));
  if (after.video?.w > 0 && after.active === switched?.name) break;
}

ws.close();
