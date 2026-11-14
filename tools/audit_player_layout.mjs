#!/usr/bin/env node
/**
 * 播放页留白量测：CDP 打开真实窗口 → 进播放页 → 量测画面与容器几何 + 截图。
 *
 * 只看两件事：
 *   1. 播放画面左右各白掉多少像素（stage 左边到 page 内容区左边）；
 *   2. 播放画面占视口宽/高的比例，判断「是否值得再放大」。
 *
 * 用法：node tools/audit_player_layout.mjs [outName]
 * 前置：dev 窗口带 --remote-debugging-port=9222 启动。
 */

import { writeFileSync, mkdirSync } from "node:fs";

const CDP = "http://127.0.0.1:9222/json/list";
const SHOT_DIR = ".workbuddy/shots";
const OUT = process.argv[2] || "player-layout";

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
    const res = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 86 });
    mkdirSync(SHOT_DIR, { recursive: true });
    const path = `${SHOT_DIR}/${name}.jpg`;
    writeFileSync(path, Buffer.from(res.data, "base64"));
    console.log(`[shot] ${path}`);
  }

  close() {
    this.ws.close();
  }
}

// target 必须按 port=1420 且 path 为空筛（hash 路由不算 path）：这里还有本地
// HTML 预览页，用 includes('1420') 会抓到预览页，量出来全是 0。
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

const cdp = new Cdp((await pickTarget()).webSocketDebuggerUrl);
await cdp.send("Page.enable");

const gotoPlayer = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = () => document.body.innerText;
  if (document.querySelector('.page--player')) return 'ALREADY';
  const clickText = (label) => {
    const node = [...document.querySelectorAll('button, .nav__item, a')]
      .find((n) => (n.textContent || '').trim().includes(label));
    if (!node) return false;
    node.click();
    return true;
  };
  if (!text().includes('首页')) return 'NO_NAV';
  clickText('首页');
  const waitFor = async (sel, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const node = document.querySelector(sel);
      if (node) return node;
      await sleep(250);
    }
    return null;
  };
  if (!(await waitFor('.vod-card', 30000))) return 'NO_CARDS';
  const card = document.querySelector('.vod-card');
  card.click();
  if (!(await waitFor('.detail-title-row, .page--detail, .chip', 30000))) return 'NO_DETAIL';
  await sleep(1200);
  const ep = [...document.querySelectorAll('button')]
    .find((n) => /\\u7b2c\\s*1\\s*\\u96c6/.test(n.textContent || ''));
  if (!ep) return 'NO_EPISODE';
  ep.click();
  if (!(await waitFor('.page--player', 30000))) return 'NO_PLAYER';
  await sleep(2500);
  return 'OPENED:' + location.hash;
})()`;

console.log("[step] goto player ->", await cdp.eval(gotoPlayer));
// 给播放器一点时间落尺寸（解析 / 首帧不影响容器几何，但布局要先稳定）。
await new Promise((r) => setTimeout(r, 1500));

const metrics = await cdp.eval(`(() => {
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const page = document.querySelector('.page--player');
  const cs = page ? getComputedStyle(page) : null;
  const stage = rect('.player-stage');
  const art = rect('.player-art');
  const content = document.querySelector('.content');
  const contentRect = content ? content.getBoundingClientRect() : null;
  const video = document.querySelector('video');
  return {
    viewport: { w: innerWidth, h: innerHeight },
    page: rect('.page--player'),
    pagePadding: cs ? { left: cs.paddingLeft, right: cs.paddingRight, maxWidth: cs.maxWidth } : null,
    pageVars: page ? {
      playerWidth: page.style.getPropertyValue('--player-width') || getComputedStyle(page).getPropertyValue('--player-width').trim(),
      maxHeight: getComputedStyle(page).getPropertyValue('--player-max-h').trim(),
    } : null,
    content: contentRect ? { x: Math.round(contentRect.x), w: Math.round(contentRect.width) } : null,
    stage,
    art,
    stageGapLeft: stage && contentRect ? Math.round(stage.x - contentRect.x) : null,
    artGapLeft: art && contentRect ? Math.round(art.x - contentRect.x) : null,
    widthRatio: stage ? +(stage.w / innerWidth * 100).toFixed(1) : null,
    heightRatio: stage ? +(stage.h / innerHeight * 100).toFixed(1) : null,
    video: video ? { vw: video.videoWidth, vh: video.videoHeight, cw: video.clientWidth, ch: video.clientHeight } : null,
    pageHead: rect('.page-head'),
    about: rect('.player-about, .live-bar'),
    episodes: rect('.player-episodes'),
    scrollHeight: document.querySelector('.content')?.scrollHeight ?? null,
  };
})()`);

console.log(JSON.stringify(metrics, null, 2));
await cdp.shot(OUT);
cdp.close();
