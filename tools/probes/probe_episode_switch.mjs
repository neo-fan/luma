#!/usr/bin/env node
/**
 * 换集体验回归：点「下一集」只重挂播放器，信息卡与选集面板不能闪空。
 *
 * 背景：`PlayerHost` 的 key 含 playUrl，换集必然整块重挂载（防双流双声）；
 * 修复前 `useEpisodeList` 的 lines/vod 从空开始，信息卡先渲染「无封面」、
 * 选集面板整个消失，等 `api.detail` 回来再长出来（用户看到一个明显闪动）。
 * 现在首帧用 `pageCache.peek` 的详情做种子，本探针在 40~3500ms 逐拍采样锁死。
 *
 * 依赖 dev 窗口（CDP 9222）、真实配置与外网。关键词可用 LUMA_KEYWORD 覆盖。
 *
 *   node tools/probes/probe_episode_switch.mjs
 */
import { connect, finish } from "./lib/cdp.mjs";

const keyword = process.env.LUMA_KEYWORD || "庆余年";
const cdp = await connect();
const problems = [];

const SNAPSHOT = `(() => {
  const img = document.querySelector('.player-about__poster img, .player-about img');
  const active = document.querySelector('.player-episodes .episode.is-active');
  return {
    hash: location.hash,
    about: Boolean(document.querySelector('.player-about')),
    posterSrc: img ? String(img.getAttribute('src') || '').slice(-24) : null,
    posterOk: img ? img.complete && img.naturalWidth > 0 : null,
    title: document.querySelector('.player-about__title')?.textContent?.trim().slice(0, 16) || null,
    chips: document.querySelector('.player-about .chip-row--static')?.children.length ?? -1,
    hasDesc: Boolean(document.querySelector('.player-about .detail-content')),
    episodes: document.querySelectorAll('.player-episodes .episode').length,
    active: active ? active.textContent.trim().slice(0, 12) : null,
    videoSrc: (document.querySelector('video')?.currentSrc || '').slice(-12),
  };
})()`;

// 1) 搜索 → 详情 → 播放
await cdp.eval("location.hash = '#/search'");
await cdp.sleep(1200);
const submitted = await cdp.eval(`(() => {
  const input = document.querySelector('.content input.input');
  if (!input) return 'no-input';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(keyword)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.closest('form')?.requestSubmit();
  return 'submitted';
})()`);
if (submitted !== "submitted") problems.push(`搜索框不可用：${submitted}`);
await cdp.sleep(9000);

const opened = await cdp.eval(`(() => {
  const card = document.querySelector('.content .vod-card');
  if (!card) return null;
  card.click();
  return card.getAttribute('title');
})()`);
if (!opened) {
  console.log("[FAIL] 搜索没有结果卡片（网络或配置问题）");
  cdp.close();
  process.exit(1);
}
console.log("打开详情:", opened);

// 详情页可能是单集（无「播放」按钮），直接点第一集也行。
// 慢源详情普遍要 10~25s（源侧偶发还要重试），定长 sleep 是假阴性来源，
// 改成轮询到出现可点入口为止（2026-11-16 探针在庆余年上连续误报两次）。
const entered = await cdp.eval(`(async () => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const play = [...document.querySelectorAll('.content button')].find((node) => /^播放/.test(node.textContent.trim()));
    if (play) { play.click(); return 'play-button'; }
    const episode = document.querySelector('.content .episode');
    if (episode) { episode.click(); return 'episode'; }
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
})()`);
if (!entered) {
  console.log("[FAIL] 详情页既没有播放按钮也没有选集");
  cdp.close();
  process.exit(1);
}
console.log("进入播放:", entered);
await cdp.sleep(7000);

const baseline = await cdp.eval(SNAPSHOT);
console.log("before:", JSON.stringify(baseline));
if (baseline.hash.startsWith("#/player") === false) problems.push(`没进播放页：${baseline.hash}`);
if (!baseline.about) problems.push("播放页缺少信息卡");
if (baseline.episodes < 2) {
  console.log("[SKIP] 该片没有多集，无法验证换集");
  cdp.close();
  process.exit(0);
}

// 2) 控制条 3 秒后自动隐藏：先移鼠标进播放器唤出，再按 rect 中心真实点击
await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: 420, buttons: 0 });
await cdp.sleep(500);
const target = await cdp.eval(`(() => {
  const node = [...document.querySelectorAll('.art-controls .art-control, .art-control')]
    .find((item) => /下一集|next/i.test((item.getAttribute('aria-label') || '') + (item.getAttribute('title') || '')));
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, visible: rect.width > 0 && rect.height > 0 };
})()`);
if (!target || !target.visible) {
  console.log("[FAIL] 控制条里找不到可点的「下一集」");
  cdp.close();
  process.exit(1);
}
await cdp.click(target.x, target.y);

// 3) 逐拍采样
const rows = [];
let elapsed = 0;
for (const at of [40, 120, 260, 500, 1000, 2000, 3500]) {
  await cdp.sleep(at - elapsed);
  elapsed = at;
  const snap = await cdp.eval(SNAPSHOT);
  rows.push({ at, snap });
  console.log(`+${at}ms`, JSON.stringify(snap));
}

for (const { at, snap } of rows) {
  if (!snap.about) problems.push(`${at}ms: 信息卡消失`);
  if (!snap.title) problems.push(`${at}ms: 标题为空`);
  if (snap.chips !== baseline.chips) problems.push(`${at}ms: chips ${snap.chips} ≠ ${baseline.chips}`);
  if (snap.episodes !== baseline.episodes) problems.push(`${at}ms: 集数 ${snap.episodes} ≠ ${baseline.episodes}`);
  if (!snap.hasDesc) problems.push(`${at}ms: 简介消失`);
  if (snap.posterOk !== true) problems.push(`${at}ms: 封面未出图`);
}
// 与基线比而不是与 +40ms 采样比：原地切换 + 按集缓存命中时 40ms 内就已完成，
// 首拍即新集会误报「没有前进」（2026-11-15 实测）。
const advanced = baseline.active !== rows.at(-1)?.snap?.active;
const videoChanged = baseline.videoSrc !== rows.at(-1)?.snap?.videoSrc;
if (!advanced) problems.push("当前集没有前进（点击可能没命中）");
if (!videoChanged) problems.push("视频源没有切换");
console.log("advanced:", rows[0]?.snap?.active, "->", rows.at(-1)?.snap?.active, "| video:", baseline.videoSrc, "->", rows.at(-1)?.snap?.videoSrc);

const code = finish(problems);
cdp.close();
process.exit(code);
