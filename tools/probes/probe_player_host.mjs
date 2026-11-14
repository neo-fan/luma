#!/usr/bin/env node
/**
 * 播放页独立化验收：进播放页 → 等出画 → 切首页 → 确认仍在播 → 切回「播放」。
 *
 * 用法：node tools/probes/probe_player_host.mjs <siteKey> <vodId> <线路名关键字> [集序=1]
 */
const CDP = "http://127.0.0.1:9222/json/list";
const [siteKey, vodId, lineWord = "", epNo = "1"] = process.argv.slice(2);
if (!siteKey || !vodId) {
  console.error("usage: node tools/probes/probe_player_host.mjs <siteKey> <vodId> <lineWord> [epNo]");
  process.exit(2);
}
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
};

const snap = () =>
  evaluate(`(() => {
    const host = document.querySelector('.player-host');
    const v = document.querySelector('video');
    const items = [...document.querySelectorAll('.nav__item')].map((n) => n.textContent.trim());
    return {
      hash: location.hash,
      hostIdle: host ? host.classList.contains('is-idle') : null,
      hostVisible: host ? getComputedStyle(host).visibility : null,
      video: v ? { w: v.videoWidth, h: v.videoHeight, t: +v.currentTime.toFixed(1), paused: v.paused } : null,
      nav: items,
    };
  })()`);

const step = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(250); } return null; };
  location.hash = '#/detail/' + encodeURIComponent(${JSON.stringify(siteKey)}) + '/' + encodeURIComponent(${JSON.stringify(vodId)});
  const chip = await waitFor(() => [...document.querySelectorAll('.chip-row--lines .chip')]
    .find((c) => (c.textContent || '').includes(${JSON.stringify(lineWord)})), 40000);
  if (!chip) return 'NO_CHIP';
  chip.click();
  await sleep(900);
  const eps = [...document.querySelectorAll('.episode-grid .episode')];
  const ep = eps[${Number(epNo) - 1}] || eps[0];
  if (!ep) return 'NO_EPISODE';
  ep.click();
  return 'PLAYING';
})()`);
console.log("[step]", step);

let played = null;
for (let i = 0; i < 25; i += 1) {
  const s = await snap();
  played = s;
  if (s.video && s.video.w > 0 && s.video.t > 1) break;
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("[playing]", JSON.stringify(played));
if (!played?.video || played.video.w === 0) {
  console.log("RESULT: NO_FRAME（没出画，后续断言跳过）");
  ws.close();
  process.exit(1);
}

// 切首页：播放器必须隐藏但仍挂着 video，时间继续走
const t0 = played.video.t;
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('.nav__item')].find((n) => n.textContent.trim() === '首页');
  btn?.click();
  return !!btn;
})()`);
await new Promise((r) => setTimeout(r, 6000));
const behind = await snap();
console.log("[after home]", JSON.stringify(behind));

// 切回「播放」：同一个 video 应还在，进度继续
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('.nav__item')].find((n) => n.textContent.trim() === '播放');
  btn?.click();
  return !!btn;
})()`);
await new Promise((r) => setTimeout(r, 2500));
const back = await snap();
console.log("[back]", JSON.stringify(back));

const okBehind = behind.hostIdle === true && behind.video !== null;
const advanced = behind.video && behind.video.t > t0;
const okBack = back.hostIdle === false && back.video !== null;
console.log(
  JSON.stringify({
    PASS: okBehind && okBack && Boolean(advanced),
    hiddenWhileAway: behind.hostIdle,
    stillHasVideo: Boolean(behind.video),
    timeAdvanced: advanced,
    backVisible: back.hostIdle === false,
  }),
);
ws.close();
