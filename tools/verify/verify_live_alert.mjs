#!/usr/bin/env node
/**
 * 直播页「错误条」生命周期验收（真实源）：
 *  1. 出画期间不得同时挂着错误条（用户报的现象：画面已经在放 1080P，
 *     顶上却显示「该频道暂时无法播放，可以换一个频道。」）；
 *  2. 错误条出现后必须在 10s 左右自行消失（`ErrorBar autoHideMs`），
 *     不能一直顶在那里等用户换台；
 *  3. 顺带确认错误条本身是可见的（不是被 CSS 藏起来造成的「消失」）。
 *
 * 用法：node tools/verify/verify_live_alert.mjs [时长秒]
 * 采样口径：250ms 一次，只在状态变化时打点，避免刷屏。
 */
import { writeFileSync, mkdirSync } from "node:fs";

const TRACE_MS = (Number(process.argv[2]) || 90) * 1000;
mkdirSync("tools/.out/shots", { recursive: true });

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
await new Promise((r, j) => {
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
function send(method, params = {}) {
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
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  }
  return r.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});

// 进直播页并等频道目录出来
await evaluate(`location.hash = '#/live'`);
const ready = await (async () => {
  const end = Date.now() + 40000;
  while (Date.now() < end) {
    const n = await evaluate(`document.querySelectorAll('.live-rail__item, .channel-item, [data-channel]').length`);
    if (n > 0) return n;
    await sleep(400);
  }
  return 0;
})();
if (!ready) throw new Error("直播频道列表未加载");
console.log(`[step] 频道条目 ${ready} 个，开始采样`);

const SAMPLE = `(() => {
  const bar = [...document.querySelectorAll('.error-bar')].find((el) => el.checkVisibility({
    visibilityProperty: true,
    opacityProperty: true,
  }));
  const toastEl = [...document.querySelectorAll('[data-sonner-toast]')].find((el) =>
    el.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
  );
  const video = [...document.querySelectorAll('video')].find(
    (v) => v.checkVisibility({ visibilityProperty: true }),
  );
  const tip = document.querySelector('.page--live > .tip');
  return {
    bar: bar ? (bar.querySelector('.error-bar__text')?.textContent || '').trim() : "",
    barCountdown: bar?.querySelector('.notice-countdown')?.textContent || "",
    toast: toastEl ? (toastEl.textContent || '').trim().slice(0, 40) : "",
    tip: tip ? (tip.textContent || '').trim() : "",
    video: video
      ? { rs: video.readyState, paused: video.paused, w: video.videoWidth, t: +video.currentTime.toFixed(1) }
      : null,
    channel: document.querySelector('.live-bar__title')?.textContent?.trim() || '',
  };
})()`;

const rows = [];
let prev = "";
let shotTaken = false;
const start = Date.now();
while (Date.now() - start < TRACE_MS) {
  const s = await evaluate(SAMPLE);
  const key = JSON.stringify({
    b: s.bar,
    cd: s.barCountdown,
    to: s.toast,
    t: s.tip,
    v: s.video?.rs,
    w: s.video?.w,
    c: s.channel,
  });
  if (key !== prev) {
    prev = key;
    const both = !!s.bar && (s.video?.w ?? 0) > 0 && (s.video?.rs ?? 0) >= 2;
    rows.push({ at: Date.now() - start, both, ...s });
    console.log(
      `${String(((Date.now() - start) / 1000).toFixed(1)).padStart(6)}s ` +
        `bar=${s.bar ? `"${s.bar}"${s.barCountdown ? ` [${s.barCountdown}]` : ""}` : "—"}  ` +
        `toast=${s.toast ? `"${s.toast}"` : "—"}  ` +
        `video=${s.video ? `${s.video.rs}/${s.video.w}px/${s.video.paused ? "paused" : "play"}` : "—"}` +
        `  台=${s.channel || "—"}` +
        (both ? "   << 出画仍有错误条" : ""),
    );
    if (both && !shotTaken) {
      shotTaken = true;
      const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 85 });
      writeFileSync(
        "tools/.out/shots/live-alert-overlap.jpg",
        Buffer.from(shot.result.data, "base64"),
      );
      console.log("[shot] tools/.out/shots/live-alert-overlap.jpg");
    }
  }
  await sleep(250);
}

// ---- 结论 ----
const overlaps = rows.filter((r) => r.both);
/** 每次「出现 → 消失」的持续时长；用于核对 TTL（warn 8s / info 4s）。 */
function spansOf(pick) {
  const spans = [];
  let open = null;
  for (const r of rows) {
    const text = pick(r);
    if (text && !open) open = { r, text };
    if (!text && open) {
      spans.push({ text: open.text, ms: r.at - open.r.at });
      open = null;
    }
  }
  if (open) spans.push({ text: open.text, ms: Date.now() - start - open.r.at });
  return spans;
}
const spans = spansOf((r) => r.bar);
const toastSpans = spansOf((r) => r.toast);

const playing = rows.some((r) => (r.video?.w ?? 0) > 0);
// error-bar 常驻（sticky）或 8s 收起都合法；这里只抓「远超表值」的泄漏。
const longLived = spans.filter((s) => s.ms > 9_000);
const toastLongLived = toastSpans.filter((s) => s.ms > 9_000);

console.log("\n=== 结论 ===");
console.log(`出画：${playing ? "是" : "否"}`);
console.log(`出现过的错误条：${spans.length ? spans.map((s) => `${s.text}(${Math.round(s.ms)}ms)`).join(" | ") : "无"}`);
console.log(`出现过的 toast：${toastSpans.length ? toastSpans.map((s) => `${s.text}(${Math.round(s.ms)}ms)`).join(" | ") : "无"}`);
console.log(`出画且挂错误条：${overlaps.length} 帧`);
console.log(`超出 TTL 仍未消失：错误条 ${longLived.length} 条 / toast ${toastLongLived.length} 条`);

// 「没出画 + 没错误条」过去会让三个计数全 0 而误报 PASS。先要求确实出画，
// 再谈错误条生命周期；否则直播黑屏这个用户故障被静默放过。
const ok = playing && overlaps.length === 0 && longLived.length === 0 && toastLongLived.length === 0;
console.log(ok ? "PASS" : "FAIL");
ws.close();
process.exit(ok ? 0 : 1);
