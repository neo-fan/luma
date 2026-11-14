#!/usr/bin/env node
/**
 * IPC 级取证：给 invoke 打点，记录每次调用的开始/结束耗时，进播放页后回读。
 * 用来区分「哪一条 IPC 卡住」与「IPC 都回来了但 UI 没推进」。
 *
 * 用法：node tools/probes/probe_ipc_trace.mjs <siteKey> <vodId> <线路名关键字>
 */
const CDP = "http://127.0.0.1:9222/json/list";
const [siteKey, vodId, lineWord = ""] = process.argv.slice(2);
const target = (await (await fetch(CDP)).json()).find((t) => {
  try {
    const u = new URL(t.url);
    return t.type === "page" && u.port === "1420" && u.pathname === "/";
  } catch {
    return false;
  }
});
if (!target) throw new Error("no target");
const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const s = pending.get(m.id);
    pending.delete(m.id);
    s(m);
  }
});
const send = async (method, params = {}) => {
  const id = ++seq;
  const reply = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(method + " timeout")), 90000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      res(m);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  if (reply.error) throw new Error(reply.error.message);
  return reply.result;
};
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
  }
  return r.result?.value;
};

// 1) 装钩子
await evaluate(`(() => {
  if (window.__lumaIpcHooked) { window.__lumaCalls = []; return 'RESET'; }
  window.__lumaIpcHooked = true;
  window.__lumaCalls = [];
  const inner = window.__TAURI_INTERNALS__;
  const orig = inner.invoke.bind(inner);
  let seq = 0;
  inner.invoke = function (cmd, args) {
    const id = ++seq;
    const row = { id, cmd, start: Math.round(performance.now()), ms: null, err: '' };
    window.__lumaCalls.push(row);
    return orig(cmd, args).then(
      (v) => { row.ms = Math.round(performance.now() - row.start); return v; },
      (e) => { row.ms = Math.round(performance.now() - row.start); row.err = String(e && (e.message || e)).slice(0, 120); throw e; },
    );
  };
  return 'HOOKED';
})()`);

// 2) 进播放页
const step = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(250); } return null; };
  location.hash = '#/detail/' + encodeURIComponent(${JSON.stringify(siteKey)}) + '/' + encodeURIComponent(${JSON.stringify(vodId)});
  const chip = await waitFor(() => [...document.querySelectorAll('.chip-row--lines .chip')]
    .find((c) => (c.textContent || '').includes(${JSON.stringify(lineWord)})), 40000);
  if (!chip) return 'NO_CHIP';
  chip.click();
  await sleep(700);
  const ep = await waitFor(() => document.querySelector('.episode-grid .episode'), 15000);
  if (!ep) return 'NO_EPISODE';
  ep.click();
  return 'PLAYING';
})()`);
console.log("[step]", step);

for (const wait of [5000, 10000, 15000]) {
  await new Promise((r) => setTimeout(r, wait === 5000 ? 5000 : 5000));
  const snap = await evaluate(`(() => {
    const v = document.querySelector('video');
    const rows = (window.__lumaCalls || []).slice(-14);
    return {
      video: v ? { w: v.videoWidth, t: +v.currentTime.toFixed(1), ready: v.readyState } : null,
      text: (document.querySelector('.page--player')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 60),
      calls: rows.map((r) => r.cmd + ' ' + (r.ms === null ? 'PENDING(' + (Math.round(performance.now()) - r.start) + 'ms)' : r.ms + 'ms') + (r.err ? ' ERR:' + r.err : '')),
    };
  })()`);
  console.log(`[t+${wait}ms]`, JSON.stringify(snap, null, 2));
  if (snap.video && snap.video.w > 0) break;
}
ws.close();
