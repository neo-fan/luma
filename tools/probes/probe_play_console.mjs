#!/usr/bin/env node
/**
 * 播放页运行时取证：订阅 CDP 的 console / 异常 / 网络失败，进入指定线路播放，
 * 收集 25s 内 hls.js 与 network 的真实报错，并采样 video 状态。
 *
 * 用法：node tools/probes/probe_play_console.mjs <siteKey> <vodId> <线路名关键字>
 */
const CDP = "http://127.0.0.1:9222/json/list";
const [siteKey, vodId, lineWord = ""] = process.argv.slice(2);
if (!siteKey || !vodId) {
  console.error("usage: node tools/probes/probe_play_console.mjs <siteKey> <vodId> [lineWord]");
  process.exit(2);
}

function isApp(t) {
  if (t.type !== "page" || !t.webSocketDebuggerUrl) return false;
  try {
    const u = new URL(t.url);
    return u.port === "1420" && u.pathname === "/";
  } catch {
    return false;
  }
}

const target = (await (await fetch(CDP)).json()).find(isApp);
if (!target) throw new Error("app target not found");

const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
const events = [];
const ready = new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const slot = pending.get(msg.id);
    pending.delete(msg.id);
    slot(msg);
    return;
  }
  if (!msg.method) return;
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args || [])
      .map((a) => a.value ?? a.description ?? a.unserializableValue ?? "")
      .join(" ");
    events.push({ kind: "console", level: msg.params.type, text: String(text).slice(0, 400) });
  } else if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    events.push({ kind: "exception", text: (d.exception?.description || d.text || "").slice(0, 400) });
  } else if (msg.method === "Network.responseReceived") {
    const r = msg.params.response;
    if (/ipc\.localhost|m3u8|\.ts|\.key|proxy/.test(r.url)) {
      events.push({ kind: "net", status: r.status, type: r.mimeType, url: r.url.slice(0, 160) });
    }
  } else if (msg.method === "Network.requestWillBeSent") {
    if (/ipc\.localhost/.test(msg.params.request.url)) {
      events.push({ kind: "ipc-req", url: msg.params.request.url.slice(0, 120), postData: (msg.params.request.postData || "").slice(0, 80) });
    }
  } else if (msg.method === "Network.loadingFailed") {
    events.push({ kind: "net-fail", text: msg.params.errorText, url: (msg.params.blockedReason || "").slice(0, 80) });
  } else if (msg.method === "Log.entryAdded") {
    const e = msg.params.entry;
    events.push({ kind: "log", level: e.level, text: `${e.text} ${e.url || ""}`.slice(0, 400) });
  }
});

async function send(method, params = {}) {
  await ready;
  const id = ++seq;
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 60000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
  return reply.result;
}
async function evaluate(expression) {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
  return res.result?.value;
}

await send("Runtime.enable");
await send("Log.enable");
await send("Network.enable");
await send("Page.enable");

// 从首页卡片进详情 → 选线路 → 点第一集
const step = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(250); } return null; };
  location.hash = '#/detail/' + encodeURIComponent(${JSON.stringify(siteKey)}) + '/' + encodeURIComponent(${JSON.stringify(vodId)});
  const chip = await waitFor(() => [...document.querySelectorAll('.chip-row--lines .chip')]
    .find((c) => (c.textContent || '').includes(${JSON.stringify(lineWord)})), 40000);
  if (!chip) return 'NO_CHIP';
  chip.click();
  await sleep(800);
  const ep = await waitFor(() => document.querySelector('.episode-grid .episode'), 15000);
  if (!ep) return 'NO_EPISODE';
  ep.click();
  return 'PLAYING';
})()`);
console.log("[step]", step);

const samples = [];
const end = Date.now() + 45000;
while (Date.now() < end) {
  const snap = await evaluate(`(() => {
    const v = document.querySelector('video');
    return {
      video: v ? { w: v.videoWidth, h: v.videoHeight, t: +v.currentTime.toFixed(1), ready: v.readyState, err: v.error ? v.error.code : 0 } : null,
      text: (document.querySelector('.page--player')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 90),
      stage: !!document.querySelector('.player-art'),
    };
  })()`);
  samples.push({ at: Math.round((Date.now() - (end - 45000)) / 1000), ...snap });
  if (snap.video && snap.video.w > 0 && snap.video.t > 1) break;
  await new Promise((r) => setTimeout(r, 1500));
}
const last = samples[samples.length - 1];
console.log("[video samples]", JSON.stringify(samples.filter((s, i) => i % 2 === 0 || s === last).slice(-8)));

const interesting = events.filter(
  (e) =>
    e.kind === "exception" ||
    e.kind === "net-fail" ||
    (e.kind === "console" && /error|warn/i.test(e.level || "")) ||
    (e.kind === "net" && e.status >= 400) ||
    (e.kind === "log" && /error|warn/i.test(e.level || "")),
);
console.log("[events]", JSON.stringify(interesting.slice(-25), null, 2));
console.log("[net ok]", JSON.stringify(events.filter((e) => e.kind === "net").slice(-8), null, 2));
ws.close();
