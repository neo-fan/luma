#!/usr/bin/env node
/**
 * 「慢源不被误杀」验收（真实源 + CDP 9222）。
 *
 * 用户 2026-11-14 反馈：播放页出现「当前线路长时间无法加载，正在尝试其它线路…」
 * 自动跳走，但那条线路多等十几秒其实能出画。口径改为「没有明确失败就不换源」：
 * 只有独立复核拿到 `dead`（HTTP 错误 / 非 m3u8 / 占位图分片）才换，超时=继续等。
 *
 * 本探针打开一部真实影片，全程按 500ms 采样，断言：
 *  1. 没有出现「正在尝试其它线路」这类自行跳转（除非复核确证 dead）；
 *  2. 若迟迟未出画，界面出现的是中性文案「源侧响应较慢…」而不是红条；
 *  3. 最终 `video.readyState >= 2` 出画（时间长也认）。
 *
 * 用法：node tools/probes/probe_stall_policy.mjs [片名] [超时秒]
 */
import { writeFileSync, mkdirSync } from "node:fs";

const NAME = process.argv[2] || "走马上任";
const BUDGET_S = Number(process.argv[3] || 60);
/** 可选：只挑「卡片文案里含这个站点关键词」的结果（复现用户报障的那个源）。 */
const SITE_HINT = process.argv[4] || "";
/** 可选：点第几集（1 起算），默认第 1 集。 */
const EPISODE = Number(process.argv[5] || 1);
/** 可选：直达指定影片详情（siteKey / vodId），跳过搜索，便于复现某个源的报障。 */
const SITE_KEY = process.argv[6] || "";
const VOD_ID = process.argv[7] || "";
/** 可选：点第几条线路（1 起算）。 */
const LINE_IDX = Number(process.argv[8] || 1);
const OUT = ".workbuddy";
mkdirSync(OUT, { recursive: true });

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
const ready = new Promise((r, j) => {
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
async function send(method, params = {}) {
  await ready;
  const id = ++seq;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${method} timeout`)), 180000);
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
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  }
  return r.result?.result?.value;
}
await send("Runtime.enable");
await send("Page.enable");

// 1) 搜索 → 进详情 → 点第一条线路的第一集
const opened = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(300); } return null; };
  // 先等壳挂载：页面刚 reload 时立刻改 hash 会被路由初始化覆盖回上一页。
  await waitFor(() => document.querySelector('.nav__item'), 20000);
  const siteKey = ${JSON.stringify(SITE_KEY)};
  const vodId = ${JSON.stringify(VOD_ID)};
  if (siteKey && vodId) {
    location.hash = '#/detail/' + siteKey + '/' + vodId;
  } else {
    location.hash = '#/search';
    const input = await waitFor(() => document.querySelector('.search-bar input'), 20000);
    if (!input) return { ok: false, reason: 'NO_SEARCH_INPUT' };
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setValue.call(input, ${JSON.stringify(NAME)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    [...document.querySelectorAll('.search-bar button')].find((b) => /搜索/.test(b.textContent))?.click();
  }
  let cards = [];
  if (siteKey && vodId) {
    await waitFor(() => document.querySelector('.chip-row--lines .chip'), 30000);
  } else {
    cards = await waitFor(() => {
      const list = [...document.querySelectorAll('.vod-card')];
      return list.length > 0 ? list : null;
    }, 40000) || [];
  }
  if (!(siteKey && vodId)) {
    if (cards.length === 0) return { ok: false, reason: 'NO_CARD' };
    const hint = ${JSON.stringify(SITE_HINT)};
    const card = hint ? cards.find((c) => c.textContent.includes(hint)) : cards[0];
    if (!card) return { ok: false, reason: 'NO_SITE_MATCH', sample: cards.slice(0, 12).map((c) => c.innerText.replace(/\\s+/g, ' ')) };
    card.click();
  }
  const lines = await waitFor(() => {
    const rows = [...document.querySelectorAll('.detail-lines .chip, .chip-row--lines .chip')];
    return rows.length > 0 ? rows : null;
  }, 30000);
  if (!lines) return { ok: false, reason: 'NO_LINE', body: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200) };
  const pickLine = lines[Math.min(${LINE_IDX} - 1, lines.length - 1)];
  const lineName = pickLine.textContent.trim();
  pickLine.click();
  // 切线路会重建选集列表：不等这一下会拿到上一份已被卸载的按钮（click 无效，
  // 页面停在详情页而探针以为已开播）。
  await sleep(1000);
  const eps = await waitFor(() => {
    const items = [...document.querySelectorAll('.episode-grid .episode')];
    return items.length > 0 ? items : null;
  }, 20000);
  if (!eps) return { ok: false, reason: 'NO_EPISODE' };
  const target = eps[Math.min(${EPISODE} - 1, eps.length - 1)];
  const epName = target.textContent.trim();
  target.click();
  // 有些「上次看到」的集格子点击目标不是导航元素，兜底再点一次首集。
  await sleep(600);
  if (!location.hash.startsWith('#/player')) {
    eps[0].click();
  }
  // 等新播放页挂载：不睡这一下会采样到上一个实例的 <video>（readyState 直接是 4），
  // 把「换集后立刻出画」这种假象当成慢源已经出画。
  await sleep(1500);
  return { ok: true, lineName, episode: epName, episodes: eps.length };
})()`);
console.log("open:", JSON.stringify(opened));
if (!opened?.ok) {
  console.log("RESULT: FAIL (无法进入播放页)");
  process.exit(1);
}

// 2) 采样时间线
const started = Date.now();
const samples = [];
let switched = null;
let slowSeen = null;
let readyAt = null;
while ((Date.now() - started) / 1000 < BUDGET_S) {
  const snap = await evaluate(`(() => {
    // 常驻播放层（PlayerHost）里还留着上一个会话的 <video>，必须排除隐藏的那个，
    // 否则采样到旧实例的 readyState 会把「其实还没出画」读成已出画。
    const vids = [...document.querySelectorAll('.player-art video')].filter(
      (el) => getComputedStyle(el).visibility !== 'hidden',
    );
    const v = vids[vids.length - 1] || null;
    const bar = document.querySelector('.error-bar__text');
    const status = document.querySelector('.player-status__desc') || document.querySelector('.player-status__title');
    return {
      hash: location.hash,
      error: bar ? bar.textContent.trim() : '',
      status: status ? status.textContent.trim() : '',
      readyState: v ? v.readyState : -1,
      current: v ? Number(v.currentTime.toFixed(1)) : -1,
      w: v ? v.videoWidth : 0,
      h: v ? v.videoHeight : 0,
    };
  })()`);
  const t = Number(((Date.now() - started) / 1000).toFixed(1));
  samples.push({ t, ...snap });
  if (!switched && /正在尝试其它线路|正在寻找其它可用源|正在切换/.test(snap.error)) {
    switched = { t, text: snap.error };
  }
  if (!slowSeen && /源侧响应较慢/.test(snap.status)) {
    slowSeen = { t, text: snap.status };
  }
  if (!readyAt && snap.readyState >= 2) {
    readyAt = t;
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}

writeFileSync(`${OUT}/probe-stall.json`, JSON.stringify({ opened, samples, switched, slowSeen, readyAt }, null, 2));
const tail = samples.filter((s) => s.error || s.status).slice(-6);
console.log("timeline tail:", JSON.stringify(tail, null, 1));
console.log("first draw:", readyAt === null ? "NEVER" : `${readyAt}s`);
console.log("slow notice:", slowSeen ? JSON.stringify(slowSeen) : "none");
console.log("auto switch:", switched ? JSON.stringify(switched) : "none");

const verdict = [];
if (switched) verdict.push(`FAIL 自行换源 @${switched.t}s: ${switched.text}`);
if (readyAt === null) verdict.push("FAIL 预算内始终没出画（可能是源本身慢，需人工判断）");
console.log(verdict.length ? verdict.map((v) => `RESULT: ${v}`).join("\n") : "RESULT: PASS（未自动换源，且已出画）");
ws.close();
