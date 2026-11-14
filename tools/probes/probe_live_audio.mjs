#!/usr/bin/env node
/**
 * 直播播放器「独占」回归：任何时刻最多一个在出声的视频。
 *
 * 用户报过「直播后台有声音」，真实原因是切换频道 / 离开直播页时旧 `<video>`
 * 没被销毁、继续解码出音轨。这里用三个场景锁死：
 *   1. 点第一个频道播放 → 至多 1 个视频在播；
 *   2. 连续切三个频道（含切回）→ DOM 里任何时刻至多 1 个 `<video>`，
 *      且真正在推进（`!paused && currentTime > 0`）的至多 1 个；
 *   3. 离开直播页回首页 → 页面里不再有 `<video>`，脱离 DOM 的旧元素也不在播。
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
await cdp.sleep(1500);

const items = await railItems();
console.log("频道数:", items.length, items.slice(0, 6));
if (items.length < 2) {
  console.log("[SKIP] 当前配置没有足够的直播源，跳过独占回归");
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

// 场景 3：离开直播页
await cdp.eval("location.hash = '#/'");
await cdp.sleep(1600);
const left = await sample("after-leave");
console.log(left.label, JSON.stringify(left.snap));
if (left.snap.inDoc.length > 0) problems.push(`离开直播页后仍有 ${left.snap.inDoc.length} 个视频在 DOM`);
if (left.snap.advancing > 0) problems.push(`离开直播页后仍有 ${left.snap.advancing} 个视频在推进`);

const code = finish(problems);
cdp.close();
process.exit(code);
