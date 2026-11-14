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

  /**
   * 冻结一帧再截：提示层常常只存在几十毫秒，`captureScreenshot` 有几十毫秒
   * 的抓取延迟，直接截会拍到「提示已消失、ArtPlayer loading 回来」的下一帧，
   * 与同一次采样读出的事实相反（我第一版就被这张误导过）。
   * 暂停虚拟时间后 React 状态与动画都停住，截到的就是采样那一刻。
   */
  async freezeShot(name) {
    try {
      await this.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
    } catch {
      /* 不支持就退回普通截图 */
    }
    await new Promise((r) => setTimeout(r, 120));
    await this.shot(name);
    try {
      await this.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: 200 });
    } catch {
      /* ignore */
    }
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
  // 判「CSS 是否让它显示」用 checkVisibility：比手写 display/尺寸更贴近真值
  // ——测量到过 display:flex 但矩形还是 0 的瞬间（ArtPlayer 刚重建），
  // 按尺寸判会把它当成不可见，从而漏掉真实重合。
  const shown = (el) => {
    if (!el) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    }
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0;
  };
  /**
   * 页面里可能同时存在多个 .player-stage：PlayerHost 是常驻层（隐藏但留
   * 在 DOM），直播页/播放页各渲染自己的舞台。全局 querySelector 会随机命中
   * 隐藏那个，读出来的 display 与用户所见无关（踩过：看到 is-busy 但
   * overlay「不可见」，其实取的是 is-idle 会话）。
   */
  const stages = [...document.querySelectorAll('.player-stage')];
  const stage = stages.find((s) => shown(s)) || stages[0] || null;
  const loadingEl = stage?.querySelector('.art-loading') || null;
  const player = stage?.querySelector('.art-video-player') || null;
  const overlay = stage?.querySelector('.player-overlay') || null;
  const pulse = stage?.querySelector('.player-status__pulse') || null;
  const video = stage?.querySelector('video') || null;
  return {
    stage: stage?.className || null,
    stageCount: stages.length,
    overlay: shown(overlay),
    title: stage?.querySelector('.player-status__title')?.textContent || '',
    pulse: shown(pulse) ? rect(pulse) : null,
    loading: {
      exists: !!loadingEl,
      display: loadingEl ? getComputedStyle(loadingEl).display : null,
      visible: shown(loadingEl),
      inner: rect(loadingEl?.firstElementChild || null),
    },
    mask: !!player && player.classList.contains('art-mask-show'),
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
  // RELOAD 模式直接复用正在播的会话，不来回导航（首页首卡常常是频道而不是剧集）。
  if (${JSON.stringify(!!process.env.RELOAD)} && location.hash.startsWith('#/player') && document.querySelector('.player-stage video')) {
    return 'REUSE:' + location.hash;
  }
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

/**
 * RELOAD=1：先等到真实出画，再点控制栏的「刷新」。
 *
 * 这是「ArtPlayer 实例已挂载 + 我们显示提示层」的稳定造法——解析阶段
 * ArtPlayer 还没创建（`.art-loading` 是 absent），只能靠重解析把两者凑到一起。
 */
if (process.env.RELOAD) {
  const ready = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // 上限 25s：CDP 单次 Runtime.evaluate 在 40s 就超时，别把等待放到超时之外。
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      const v = document.querySelector('video');
      if (v && v.videoWidth > 0 && !v.paused) return 'READY:' + v.videoWidth + 'x' + v.videoHeight;
      await sleep(300);
    }
    return 'NO_PLAY';
  })()`);
  console.log("[step] wait first frame ->", ready);
  const clicked = await cdp.eval(`(() => {
    const btn = document.querySelector('.player-art .art-control-reload');
    if (!btn) return 'NO_RELOAD';
    btn.click();
    return 'CLICKED';
  })()`);
  console.log("[step] reload ->", clicked);
}

/** 追踪 60s：只在状态变化时打点，同时记录「提示层 + 内置 loading 同时可见」。 */
const TRACE_MS = 60000;
/**
 * 采样间隔 120ms：命中缓存的线路「刷新」时提示层只活 60~100ms（实测一帧
 * 还在「正在重新获取播放地址…」，下一帧就没了），250ms 会整段错过。
 */
const SAMPLE_INTERVAL = 120;
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
        `  stage=${(s.stage || "—").replace("player-stage", "stage")}[${s.stageCount}]` +
        `  art-loading=${s.loading.exists ? (s.loading.visible ? "VISIBLE" : `hidden(${s.loading.display})`) : "absent"}` +
        `  mask=${s.mask ? "on" : "off"}  video=${s.video ? `${s.video.readyState}/${s.video.paused ? "paused" : "play"}` : "—"}` +
        (both ? "   << OVERLAP" : ""),
    );
    // 每种提示文案各拍一张，用于肉眼确认「中间只剩一套指示器」。
    if (s.overlay && !shotTitles.has(s.title)) {
      shotTitles.add(s.title);
      await cdp.freezeShot(`player-overlay-${s.title.replace(/[^\u4e00-\u9fa5a-z0-9]+/gi, "_").slice(0, 18)}`);
    }
    if (both && !overlapShot) {
      overlapShot = true;
      await cdp.freezeShot("player-overlay-overlap");
    }
  }
  await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL));
}

const overlaps = rows.filter((r) => r.both);
const overlayFrames = rows.filter((r) => r.overlay);
const loadingSeen = rows.some((r) => r.loading.visible);
const playingSeen = rows.some((r) => (r.video?.w ?? 0) > 0);

console.log("\n=== 结论 ===");
console.log(`提示层采样帧：${overlayFrames.length}（${new Set(overlayFrames.map((r) => r.title)).size} 种文案）`);
console.log(`重合帧：${overlaps.length}`);
console.log(`内置 loading 曾可见：${loadingSeen ? "是" : "否"}`);
console.log(`出画（videoWidth>0）：${playingSeen ? "是" : "否"}`);
if (overlaps.length > 0) {
  console.log("样例：", JSON.stringify(overlaps[0], null, 2));
}
if (overlayFrames.length === 0) {
  console.log("INCONCLUSIVE：一次都没采到提示层，这次的 PASS 不成立（换慢源或加 RELOAD=1）");
} else {
  console.log(overlaps.length === 0 ? "PASS：提示层存在期间没有内置 loading 叠上来" : "FAIL：两者同时可见");
}

cdp.close();
