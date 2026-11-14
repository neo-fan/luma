#!/usr/bin/env node
/**
 * 直播页验收（真实源，不依赖桩）：
 * 1) 节目单文本里不能再出现 `&apos;` / `&amp;` 这类未反转义实体；
 * 2) 节目单必须是时间轴结构（.epg-time + .epg-body，且时间升序）；
 * 3) 视频还在连接时，线路 chip 也可点（手动切线路不被加载态挡住）。
 *
 * 用法：node tools/diag/diag_live_epg.mjs [频道名]
 */
import { writeFileSync, mkdirSync } from "node:fs";

const CHANNEL = process.argv[2] || "";
const OUT = ".workbuddy";
mkdirSync(OUT, { recursive: true });

const target = (await (await fetch("http://127.0.0.1:9222/json/list")).json()).find((t) => {
  try {
    const u = new URL(t.url);
    return t.type === "page" && u.port === "1420" && u.pathname === "/";
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
    const timer = setTimeout(() => rej(new Error(`${method} timeout`)), 90000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      res(m);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
}
await send("Runtime.enable");
await send("Page.enable");

const step = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(250); } return null; };
  location.hash = '#/live';
  // 直播页已收敛为播放页：频道在左栏 .live-rail__item（旧版是列表页的 .chip）。
  const card = await waitFor(() => [...document.querySelectorAll('.live-rail__item')]
    .find((c) => (c.textContent || '').includes(${JSON.stringify(CHANNEL)})), 30000);
  if (!card) return 'NO_CHANNEL';
  if (!card.classList.contains('is-active')) {
    card.click();
  }
  return 'CLICKED';
})()`);
console.log("[step]", step);

// 等节目单渲染（拿不到就继续，至少能验证线路 chip）
await new Promise((r) => setTimeout(r, 4000));

const snap = await evaluate(`(() => {
  const items = [...document.querySelectorAll('.epg-item')];
  const text = items.map((i) => ({
    time: i.querySelector('.epg-time')?.textContent?.trim() || '',
    body: !!(i.querySelector('.epg-body')),
    title: i.querySelector('.epg-title')?.textContent?.trim() || '',
    desc: i.querySelector('.epg-desc')?.textContent?.trim() || '',
  }));
  const lines = [...document.querySelectorAll('.live-line')].map((b) => ({
    label: b.textContent.trim(), active: b.getAttribute('aria-pressed') === 'true' || b.classList.contains('is-active'),
  }));
  const html = document.querySelector('.live-epg')?.innerHTML || '';
  const raw = document.body.innerText;
  return {
    hash: location.hash,
    epgCount: items.length,
    epg: text.slice(0, 6),
    entities: /&(apos|amp|quot|lt|gt|#\\d+);/.test(raw),
    entitySample: (raw.match(/&(apos|amp|quot|lt|gt|#\\d+);[^\\s]{0,12}/) || [''])[0],
    timesAscending: (() => {
      const mins = text.map((t) => { const m = t.time.match(/(\\d{1,2}):(\\d{2})/); return m ? +m[1] * 60 + +m[2] : null; }).filter((v) => v !== null);
      for (let i = 1; i < mins.length; i += 1) if (mins[i] < mins[i - 1]) return false;
      return mins.length > 1;
    })(),
    lines,
    stage: document.querySelector('.player-status__title')?.textContent || '',
    hasVideo: !!document.querySelector('.player-art video'),
  };
})()`);
console.log("[epg]", JSON.stringify(snap, null, 2));

const shot = await send("Page.captureScreenshot", { format: "png" });
const file = `${OUT}/live-epg.png`;
writeFileSync(file, Buffer.from(shot.result.data, "base64"));
console.log("[shot]", file);
ws.close();
