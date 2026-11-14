#!/usr/bin/env node
/**
 * 播放页「自绘提示层」与「ArtPlayer 内置 loading」重叠验收。
 *
 * 背景（2026-11-14 用户反馈）：解析/缓冲时画面正中有两个转圈——我们自己的
 * 呼吸光环（.player-status__pulse）和 ArtPlayer 内置的 50px 旋转 loading
 * （.art-loading 里的 svg），几何完全重合。
 *
 * 量测口径：同时满足「提示层存在」且「.art-loading 实际可见（display≠none
 * 且矩形有面积）」= 重合。提示层消失后内置 loading 必须恢复默认可见性，
 * 否则是「把正常缓冲提示也一起藏了」的过度修复。
 *
 * 用法：
 *   node tools/diag_player_overlay.mjs            # 自动挑一个首页有数据的站
 *   SITE=非凡 node tools/diag_player_overlay.mjs   # 指定站（key 或中文名）
 * 前置：dev 窗口带 --remote-debugging-port=9222 启动。
 */

import { writeFileSync, mkdirSync } from "node:fs";

const CDP = "http://127.0.0.1:9222/json/list";
const SHOT_DIR = ".workbuddy/shots";
const WANT_SITE = process.env.SITE || "";

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      const slot = this.pending.get(msg.id);
      if (slot) {
        this.pending.delete(msg.id);
        slot(msg);
      }
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 40000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result;
  }

  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) throw new Error(`eval failed: ${res.exceptionDetails.text}`);
    return res.result?.value;
  }

  async shot(name) {
    const res = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 88 });
    mkdirSync(SHOT_DIR, { recursive: true });
    const path = `${SHOT_DIR}/${name}.jpg`;
    writeFileSync(path, Buffer.from(res.data, "base64"));
    console.log(`[shot] ${path}`);
  }

  close() {
    this.ws.close();
  }
}

function isAppTarget(t) {
  if (t.type !== "page" || !t.webSocketDebuggerUrl) return false;
  try {
    const url = new URL(t.url);
    return url.port === "1420" && url.pathname === "/";
  } catch {
    return false;
  }
}

async function pickTarget(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(CDP)).json();
      const page = list.find(isAppTarget);
      if (page) return page;
    } catch {
      /* CDP not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("CDP page target not found");
}

const SAMPLE = `(() => {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
  };
  const visible = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const loadingEl = document.querySelector('.player-art .art-loading');
  const player = document.querySelector('.player-art .art-video-player');
  const overlay = document.querySelector('.player-overlay');
  const stage = document.querySelector('.player-stage');
  const pulse = document.querySelector('.player-status__pulse');
  const video = document.querySelector('video');
  return {
    stage: stage?.className || null,
    overlay: !!overlay && visible(overlay),
    title: document.querySelector('.player-status__title')?.textContent || '',
    pulse: visible(pulse) ? rect(pulse) : null,
    loading: {
      exists: !!loadingEl,
      display: loadingEl ? getComputedStyle(loadingEl).display : null,
      visible: visible(loadingEl),
      inner: rect(loadingEl?.firstElementChild || null),
    },
    mask: player && player.classList.contains('art-mask-show'),
    video: video ? { readyState: video.readyState, paused: video.paused, w: video.videoWidth } : null,
  };
})()`;

const cdp = new Cdp((await pickTarget()).webSocketDebuggerUrl);
await cdp.send("Page.enable");

/**
 * 进播放页：首页没卡片时先切到一个「首页有数据」的站。
 * 默认站常是「电视┃直播」（只有频道没有推荐位），不切站永远等不到 .vod-card。
 */
const gotoPlayer = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (sel, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const node = document.querySelector(sel);
      if (node) return node;
      await sleep(250);
    }
    return null;
  };
  const clickText = (label) => {
    const node = [...document.querySelectorAll('.nav__item, button, a')]
      .find((n) => (n.textContent || '').trim().includes(label));
    if (!node) return false;
    node.click();
    return true;
  };
  // ⚠️ 播放页是常驻层（切走后仍留在 DOM，只是 visibility:hidden），
  // 判「是否在播放页」只能看 hash，不能用 document.querySelector。
  if (location.hash.startsWith('#/player')) {
    clickText('首页');
    await sleep(500);
  }
  if (!(await waitFor('.site-select__trigger', 30000))) return 'NO_HOME';

  const want = ${JSON.stringify(WANT_SITE)};
  const pickKey = async () => {
    const snap = await window.__TAURI_INTERNALS__.invoke('config_active');
    const sites = (snap?.sites || []).filter((s) => s.enabled !== false && s.api && s.runtime !== 'jvm');
    if (want) {
      const hit = sites.find((s) => s.key === want || s.name === want || s.name.startsWith(want));
      if (hit) return hit.key;
    }
    for (const s of sites.slice(0, 12)) {
      try {
        const r = await Promise.race([
          window.__TAURI_INTERNALS__.invoke('spider_invoke', { request: { siteKey: s.key, method: 'homeContent', args: [] } }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 9000)),
        ]);
        if ((r?.list || []).length > 0) return s.key;
      } catch { /* next */ }
    }
    return null;
  };

  if (want || !document.querySelector('.vod-card')) {
    const key = await pickKey();
    if (!key) return 'NO_DATA_SITE';
    const before = document.querySelector('.vod-card')?.textContent?.trim() || '';
    document.querySelector('.site-select__trigger').click();
    const item = await waitFor('.site-select__item[data-key=' + JSON.stringify(key) + ']', 8000);
    if (!item) return 'NO_SITE_ITEM';
    item.click();
    // 「见卡片 ≠ 切站完成」：旧站的卡片还在 DOM 里，必须等 data-value 落到
    // 目标站、且首卡内容真的换掉，否则会把上一站的片子当成新站的。
    const switched = await (async () => {
      const end = Date.now() + 45000;
      while (Date.now() < end) {
        const cur = document.querySelector('.site-select')?.getAttribute('data-value');
        const first = document.querySelector('.vod-card')?.textContent?.trim() || '';
        if (cur === key && first && first !== before) return true;
        await sleep(250);
      }
      return false;
    })();
    if (!switched) return 'SITE_NOT_SWITCHED:' + key;
  }

  if (!(await waitFor('.vod-card', 45000))) return 'NO_CARDS';
  document.querySelector('.vod-card').click();
  if (!(await waitFor('.detail-title-row, .page--detail, .chip', 30000))) return 'NO_DETAIL';
  await sleep(1200);
  const ep = [...document.querySelectorAll('button')]
    .find((n) => /\\u7b2c\\s*1\\s*\\u96c6/.test(n.textContent || ''));
  if (!ep) return 'NO_EPISODE';
  ep.click();
  if (!(await waitFor('.page--player', 30000))) return 'NO_PLAYER';
  return 'OPENED:' + location.hash;
})()`;

console.log("[step] goto player ->", await cdp.eval(gotoPlayer));

/** 追踪 60s：只在状态变化时打点，同时记录「提示层 + 内置 loading 同时可见」。 */
const TRACE_MS = 60000;
const rows = [];
let prev = "";
let overlapShot = false;
const shotTitles = new Set();
const end = Date.now() + TRACE_MS;
while (Date.now() < end) {
  const s = await cdp.eval(SAMPLE);
  const key = JSON.stringify({
    o: s.overlay,
    t: s.title,
    ld: s.loading.visible,
    m: s.mask,
    v: s.video?.readyState ?? null,
    p: s.video?.paused ?? null,
  });
  if (key !== prev) {
    prev = key;
    const both = s.overlay && s.loading.visible;
    rows.push({ at: new Date().toISOString().slice(11, 19), both, ...s });
    console.log(
      `${new Date().toISOString().slice(11, 19)}  overlay=${s.overlay ? `"${s.title}"` : "—"}` +
        `  stage=${(s.stage || "—").replace("player-stage", "stage")}` +
        `  art-loading=${s.loading.exists ? (s.loading.visible ? "VISIBLE" : `hidden(${s.loading.display})`) : "absent"}` +
        `  mask=${s.mask ? "on" : "off"}  video=${s.video ? `${s.video.readyState}/${s.video.paused ? "paused" : "play"}` : "—"}` +
        (both ? "   << OVERLAP" : ""),
    );
    // 每种提示文案各拍一张，用于肉眼确认「中间只剩一套指示器」。
    if (s.overlay && !shotTitles.has(s.title)) {
      shotTitles.add(s.title);
      await cdp.shot(`player-overlay-${s.title.replace(/[^\u4e00-\u9fa5a-z0-9]+/gi, "_").slice(0, 18)}`);
    }
    if (both && !overlapShot) {
      overlapShot = true;
      await cdp.shot("player-overlay-overlap");
    }
  }
  await new Promise((r) => setTimeout(r, 250));
}

const overlaps = rows.filter((r) => r.both);
const loadingSeen = rows.some((r) => r.loading.visible);
const playingSeen = rows.some((r) => (r.video?.w ?? 0) > 0);

console.log("\n=== 结论 ===");
console.log(`重合帧：${overlaps.length}（${new Set(overlaps.map((r) => r.title)).size} 种提示文案）`);
console.log(`内置 loading 曾可见：${loadingSeen ? "是" : "否"}`);
console.log(`出画（videoWidth>0）：${playingSeen ? "是" : "否"}`);
if (overlaps.length > 0) {
  console.log("样例：", JSON.stringify(overlaps[0], null, 2));
}
console.log(overlaps.length === 0 ? "PASS：提示层存在期间没有内置 loading 叠上来" : "FAIL：两者同时可见");

cdp.close();
