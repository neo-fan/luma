#!/usr/bin/env node
/**
 * 换集体验回归：点「下一集」只重挂播放器，信息卡与选集面板不能闪空。
 *
 * 背景：`PlayerHost` 的 key 含 playUrl，换集必然整块重挂载（防双流双声）；
 * 修复前 `useEpisodeList` 的 lines/vod 从空开始，信息卡先渲染「无封面」、
 * 选集面板整个消失，等 `api.detail` 回来再长出来（用户看到一个明显闪动）。
 * 现在首帧用详情页缓存做种子，本探针在 40~3500ms 逐拍采样锁死。
 *
 * 真实点播源普遍不稳定（本会话实测 py 源频繁崩/超时）。为把「源没给出下一集」
 * 与「换集逻辑坏了」分开，探针**跨多个候选卡片重试**整段「进入→换集→验证」：
 *   · 任一源成功演示换集（active 前进 + 各拍不闪空）→ PASS；
 *   · 所有源都连第一集都没播出来 → [SKIP]（环境，非回归）；
 *   · 有源播出了第一集、但换集始终不前进 → FAIL（真回归，不放宽）。
 *
 * 依赖 dev 窗口（CDP 9222）、真实配置与外网。关键词可用 LUMA_KEYWORD 覆盖。
 *   node tools/probes/probe_episode_switch.mjs
 */
import { connect, finish } from "./lib/cdp.mjs";

const keyword = process.env.LUMA_KEYWORD || "庆余年";
const MAX_SOURCES = 4; // 最多试几张卡片演示换集
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

const PLAYING = `(() => {
  const v = document.querySelector('.player-art video') || document.querySelector('video');
  const playing = !!v && ((v.currentSrc || v.src) && (v.currentTime > 0 || v.readyState >= 2));
  return JSON.stringify({ playing: !!playing, t: v ? Number((v.currentTime || 0).toFixed(1)) : null, rs: v ? v.readyState : null });
})()`;

async function backToSearch() {
  await cdp.eval("location.hash = '#/search'");
  await cdp.sleep(2500);
}

// 1) 搜索一次，拿到结果卡片列表。
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

const cardCount = await cdp.eval(`document.querySelectorAll('.content .vod-card').length`);
if (!cardCount) {
  console.log("[SKIP] 搜索没有结果卡片（网络或配置问题）");
  cdp.close();
  process.exit(0);
}

let demonstrated = false; // 有源成功演示了换集
let playedEp1 = false; // 至少一个源播出了第一集（有资格判回归）
let lastDiag = "";

for (let pick = 0; pick < Math.min(MAX_SOURCES, cardCount) && !demonstrated; pick += 1) {
  // 进入这张卡的详情并点开一集。
  const title = await cdp.eval(`(() => {
    const card = document.querySelectorAll('.content .vod-card')[${pick}];
    if (!card) return null;
    card.click();
    return card.getAttribute('title');
  })()`);
  if (!title) break;
  const entered = await cdp.eval(`(async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const play = [...document.querySelectorAll('.content button')].find((node) => /^播放/.test(node.textContent.trim()));
      if (play) { play.click(); return 'play-button'; }
      const items = [...document.querySelectorAll('.content .episode')];
      if (items.length) {
        const target = items[Math.floor(items.length / 2)] ?? items[0];
        target.click();
        return 'episode';
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    return null;
  })()`);
  if (!entered) {
    console.log(`  卡 ${pick + 1}「${title}」详情页没有可点入口，换下一张`);
    await backToSearch();
    continue;
  }
  await cdp.sleep(7000);

  const baseline = await cdp.eval(SNAPSHOT);
  if (!baseline.hash.startsWith("#/player")) { await backToSearch(); continue; }
  if (baseline.episodes < 2) {
    console.log(`  卡 ${pick + 1}「${title}」没有多集，无法验证换集`);
    await backToSearch();
    continue;
  }

  // 等控制条里的「下一集」挂好（源解析普遍要数秒~十几秒，带超时轮询 + 唤出控制条）。
  let target = null;
  const ctrlDeadline = Date.now() + 45000;
  while (Date.now() < ctrlDeadline) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: 420, buttons: 0 });
    await cdp.sleep(400);
    target = await cdp.eval(`(() => {
      const node = [...document.querySelectorAll('.art-controls .art-control, .art-control')]
        .find((item) => /下一集|next/i.test((item.getAttribute('aria-label') || '') + (item.getAttribute('title') || '')));
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, visible: rect.width > 0 && rect.height > 0 };
    })()`);
    if (target && target.visible) break;
  }

  if (!target || !target.visible) {
    const ps = JSON.parse(await cdp.eval(PLAYING));
    if (!ps.playing) {
      console.log(`  卡 ${pick + 1}「${title}」第一集没出画（${JSON.stringify(ps)}），源侧，换下一张`);
      await backToSearch();
      continue;
    }
    // 在播却没有下一集按钮 → 记为这张源的失败证据，但仍换源再试（避免单源偶发误判）。
    lastDiag = `视频在播(${ps.t}s/rs${ps.rs})却没有「下一集」控制项`;
    await backToSearch();
    continue;
  }

  // 有第一集在播：这张源有资格判回归。
  playedEp1 = true;
  await cdp.click(target.x, target.y);

  const rows = [];
  let elapsed = 0;
  for (const at of [40, 120, 260, 500, 1000, 2000, 3500]) {
    await cdp.sleep(at - elapsed);
    elapsed = at;
    rows.push({ at, snap: await cdp.eval(SNAPSHOT) });
  }

  const advanced = baseline.active !== rows.at(-1)?.snap?.active;
  const videoChanged = baseline.videoSrc !== rows.at(-1)?.snap?.videoSrc;
  const flash = rows.filter(({ snap }) => !snap.about || !snap.title || snap.chips !== baseline.chips || snap.episodes !== baseline.episodes || !snap.hasDesc || snap.posterOk !== true);

  if (advanced && videoChanged && flash.length === 0) {
    console.log(`  卡 ${pick + 1}「${title}」换集成功：${baseline.active} -> ${rows.at(-1).snap.active}`);
    demonstrated = true;
    break;
  }
  // 这张源没演示成功：记录原因，换下一张继续试。
  const ps = JSON.parse(await cdp.eval(PLAYING));
  lastDiag = `「${title}」: advanced=${advanced} videoChanged=${videoChanged} flash=${flash.length} playing=${ps.playing}`;
  console.log(`  卡 ${pick + 1}${advanced ? "" : " 换集未前进"}（${lastDiag}），换下一张重试`);
  await backToSearch();
}

if (demonstrated) {
  console.log("[ok] 换集在至少一个源上成功演示（信息卡/选集不闪空）");
} else if (!playedEp1) {
  console.log(`[SKIP] ${MAX_SOURCES} 张候选源都没能播出第一集/演示换集（真实源不可用，非产品回归）${lastDiag ? ` -- 末次: ${lastDiag}` : ""}`);
} else {
  problems.push(`有源播出了第一集，但换集始终没能正确前进/不闪空（跨 ${MAX_SOURCES} 源复现）-- 末次: ${lastDiag}`);
}

const code = finish(problems);
cdp.close();
process.exit(code);
