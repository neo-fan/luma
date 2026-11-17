#!/usr/bin/env node
/**
 * 双播放器互斥验证：
 *  1. 点播出画后切到直播 → 点播实例必须停（不出现两路同时出声）；
 *  2. 从直播切回「播放」→ 点播自动重新解析并出画（不是黑屏）。
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
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => rej(new Error(`${method} timeout`)), 120000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      res(m);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  }
  return r.result?.result?.value;
};

const snap = () =>
  ev(`JSON.stringify((() => {
    const vids = [...document.querySelectorAll('video')].map((v) => ({
      host: v.closest('.player-host') ? (v.closest('.player-host').classList.contains('is-idle') ? 'vod-idle' : 'vod') : 'page',
      rs: v.readyState,
      w: v.videoWidth,
      paused: v.paused,
      hasSrc: Boolean(v.currentSrc || v.getAttribute('src')),
      vis: getComputedStyle(v).visibility,
    }));
    return {
      hash: location.hash,
      vids,
      rail: document.querySelectorAll('.live-rail__item').length,
      playing: vids.filter((v) => !v.paused && v.rs >= 2).length,
    };
  })())`);

// 1) 从历史进点播
console.log(
  "[open-vod]",
  await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(300); } return null; };
    location.hash = '#/history';
    const card = await waitFor(() => document.querySelector('.fav-item .vod-card'), 15000);
    if (!card) return { ok: false, reason: 'NO_HISTORY' };
    card.click();
    const ep = await waitFor(() => document.querySelector('.episode-grid .episode'), 30000);
    if (!ep) return { ok: false, reason: 'NO_EPISODE' };
    ep.click();
    await sleep(1200);
    return { ok: true, hash: location.hash };
  })()`),
);

for (let i = 0; i < 20; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = JSON.parse(await snap());
  console.log(`[vod t+${(i + 1) * 2}s]`, `${s.hash} playing=${s.playing}`, JSON.stringify(s.vids));
  if (s.hash.startsWith("#/player") && s.vids.some((v) => v.w > 0 && !v.paused)) break;
}

// 2) 切直播
console.log(
  "[switch-live]",
  await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    location.hash = '#/live';
    await sleep(4000);
    return { hash: location.hash, rail: document.querySelectorAll('.live-rail__item').length };
  })()`),
);

for (let i = 0; i < 8; i += 1) {
  await new Promise((r) => setTimeout(r, 1500));
  const s = JSON.parse(await snap());
  console.log(`[live t+${(i + 1) * 1.5}s] playing=${s.playing}`, JSON.stringify(s.vids));
}

// 3) 回点播
console.log(
  "[back-vod]",
  await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const btn = [...document.querySelectorAll('.nav__item')].find((b) => /播放/.test(b.textContent || ''));
    if (!btn) return { ok: false, reason: 'NO_NAV_PLAYER' };
    btn.click();
    await sleep(1000);
    return { ok: true, hash: location.hash };
  })()`),
);

for (let i = 0; i < 20; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = JSON.parse(await snap());
  console.log(`[back t+${(i + 1) * 2}s]`, `${s.hash} playing=${s.playing}`, JSON.stringify(s.vids));
  if (s.hash.startsWith("#/player") && s.vids.some((v) => v.w > 0 && !v.paused)) break;
}

ws.close();
