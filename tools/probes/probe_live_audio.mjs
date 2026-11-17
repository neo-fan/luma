#!/usr/bin/env node
/**
 * 直播播放器「独占」回归：任何时刻最多一个在出声的视频。
 *
 * 用户报过「直播后台有声音」，真实原因是切换频道 / 离开直播页时旧 `<video>`
 * 没被销毁、继续解码出音轨。这里用三个场景锁死：
 *   1. 点第一个频道播放 → 至多 1 个视频在播；
 *   2. 连续切三个频道（含切回）→ DOM 里任何时刻至多 1 个 `<video>`，
 *      且真正在推进（`!paused && currentTime > 0`）的至多 1 个；
 *   3. 离开直播页回首页 → 常驻层「只藏不卸载」：至多 1 条流在推进（不双声、不堆叠）、
 *      脱离 DOM 的旧元素不在播（幽灵音）、且隐藏态真的断掉命中测试。
 *
 * 口径来源：`.live-host` / `.player-host` 的后台播放是 1.0.3 起的设计（回直播页复用
 * 同一条流），本探针早期版本按「离开即销毁」断言，在常驻层改造后就是假红；
 * 2026-11-17 按现行契约改写。
 *
 * 依赖 dev 窗口（CDP 9222）与一份带 `lives[]` 的 active 配置；没有直播源时记 SKIP。
 *
 *   node tools/probes/probe_live_audio.mjs
 */
import { connect, finish } from "./lib/cdp.mjs";

const cdp = await connect();
const problems = [];

const SNAPSHOT = `(() => {
  window.__probeVideos = window.__probeVideos || [];
  const inDoc = [...document.querySelectorAll('video')];
  for (const node of inDoc) if (!window.__probeVideos.includes(node)) window.__probeVideos.push(node);
  const audio = [...document.querySelectorAll('audio')];
  const describe = (node) => ({
    paused: node.paused,
    time: Number(node.currentTime.toFixed(2)),
    ready: node.readyState,
    muted: node.muted,
    src: String(node.currentSrc || "").slice(-24),
  });
  const all = window.__probeVideos.filter((node) => node.isConnected || true).map(describe);
  return {
    hash: location.hash,
    inDoc: inDoc.map(describe),
    detached: window.__probeVideos.filter((node) => !node.isConnected).map(describe),
    advancing: all.filter((item) => !item.paused && item.time > 0).length,
    audioElements: audio.length,
    audioAdvancing: audio.filter((node) => !node.paused && node.currentTime > 0).length,
  };
})()`;

const railItems = () =>
  cdp.eval(`[...document.querySelectorAll('.live-rail__item')].map((node) => node.textContent.trim().slice(0, 16))`);

const sample = (label) => cdp.eval(SNAPSHOT).then((snap) => ({ label, snap }));

/** 点轨道里第 index 个频道（0 基），返回频道名。 */
async function playChannel(index) {
  const clicked = await cdp.eval(`(() => {
    const items = [...document.querySelectorAll('.live-rail__item')];
    const item = items[${index}];
    if (!item) return null;
    item.click();
    return item.textContent.trim().slice(0, 16);
  })()`);
  if (!clicked) return null;
  await cdp.sleep(2500);
  return clicked;
}

await cdp.eval("location.hash = '#/live'");
// 频道轨道是异步填充的（一份配置两千多个台，冷缓存下 1.5s 读到 0 会假 SKIP，
// 把「源不可用」和「还没加载完」混成一件事）。轮询到出内容为止再判定。
let items = [];
const railDeadline = Date.now() + 30000;
while (Date.now() < railDeadline) {
  items = await railItems();
  if (items.length >= 2) {
    break;
  }
  await cdp.sleep(1200);
}
console.log("频道数:", items.length, items.slice(0, 6));
if (items.length < 2) {
  console.log("[SKIP] 30s 内频道轨道没内容或不足 2 个台（配置无直播源，或目录拉不回来）");
  cdp.close();
  process.exit(0);
}

// 场景 1：点一个台，等它起播
const first = await playChannel(0);
const firstSnap = await sample(`play:${first}`);
console.log(firstSnap.label, JSON.stringify(firstSnap.snap));
if (firstSnap.snap.advancing > 1) problems.push(`起播时有 ${firstSnap.snap.advancing} 个视频在推进`);
if (firstSnap.snap.audioElements > 0) problems.push("直播页出现了 <audio> 元素");

// 场景 2：连续切台，逐拍采样
for (const index of [1, 2, 0]) {
  if (index >= items.length) continue;
  const name = await playChannel(index);
  for (const wait of [80, 260, 700, 1600, 3200]) {
    await cdp.sleep(wait);
    const row = await sample(`switch:${name}+${wait}ms`);
    console.log(row.label, JSON.stringify(row.snap));
    if (row.snap.inDoc.length > 1) problems.push(`${row.label}: DOM 里有 ${row.snap.inDoc.length} 个视频`);
    if (row.snap.advancing > 1) problems.push(`${row.label}: ${row.snap.advancing} 个视频同时推进`);
  }
}

// 场景 3：离开直播页。契约不是「销毁」——常驻层（`.live-host`）的设计是
// 「只藏不卸载，音频照播不变」（layout.css:380-396 写明，回直播页还是同一条流，
// 不必重新拉流）。所以要钉的是这三件真会出事的事：
//   a. 不堆叠：DOM 里至多 1 条常驻流，脱离 DOM 的旧元素绝不能再推进（幽灵音）；
//   b. 不双声：任何时刻至多 1 个在推进，且不得出现 <audio> 兜底元素；
//   c. 不抢点击：隐藏态必须真的断掉命中测试（visibility:hidden + pointer-events:none
//      并覆盖后代——ArtPlayer 控制条自带 pointer-events:auto，曾以「看不见却吃掉
//      全页点击」的形式出过事故，取证用 elementsFromPoint）。
await cdp.eval("location.hash = '#/'");
await cdp.sleep(1600);
const left = await sample("after-leave");
console.log(left.label, JSON.stringify(left.snap));
if (left.snap.inDoc.length > 1) problems.push(`离开直播页后 DOM 里堆了 ${left.snap.inDoc.length} 个视频`);
if (left.snap.advancing > 1) problems.push(`离开直播页后有 ${left.snap.advancing} 个视频同时推进（双声）`);
if (left.snap.audioElements > 0) problems.push("离开直播页后出现了 <audio> 元素");
const ghost = left.snap.detached.filter((item) => !item.paused && item.time > 0);
if (ghost.length > 0) problems.push(`脱离 DOM 的旧直播元素仍在推进（幽灵音）：${JSON.stringify(ghost.slice(0, 2))}`);

const hidden = await cdp.eval(`(() => {
  const host = document.querySelector('.live-host');
  if (!host) return { present: false };
  const cs = getComputedStyle(host);
  const hit = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
  const stack = document.elementsFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
  return {
    present: true,
    idle: host.classList.contains('is-idle'),
    ariaHidden: host.getAttribute('aria-hidden'),
    visibility: cs.visibility,
    pointerEvents: cs.pointerEvents,
    // 关键取证：命中测试里不许出现常驻层的节点（后代自行放开 pointer-events 也会被这里抓到）
    hitInsideHost: hit ? host.contains(hit) : false,
    stackInsideHost: stack.filter((node) => host.contains(node)).map((node) => node.className || node.tagName).slice(0, 3),
  };
})()`);
console.log("隐藏态:", JSON.stringify(hidden));
if (!hidden.present) problems.push("离开直播页后常驻层被卸载了（与「只藏不卸载」的设计不符，回直播页要重新拉流）");
if (!hidden.idle) problems.push("离开直播页后 .live-host 没有 is-idle");
if (hidden.ariaHidden !== "true") problems.push(`隐藏中的常驻层 aria-hidden 应为 true，实际 ${hidden.ariaHidden}`);
if (hidden.visibility !== "hidden") problems.push(`隐藏中的常驻层 visibility 应为 hidden，实际 ${hidden.visibility}`);
if (hidden.hitInsideHost === true || (hidden.stackInsideHost || []).length > 0) {
  problems.push(`隐藏的直播常驻层仍参与命中测试：${JSON.stringify(hidden.stackInsideHost)}`);
}

const code = finish(problems);
cdp.close();
process.exit(code);
