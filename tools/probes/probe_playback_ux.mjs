#!/usr/bin/env node
/**
 * 连看体验回归：播放偏好记忆 / 自动下一集 / Esc 返回 / 错误可复制。
 *
 * 四项共用一个「临时 HTTP server + 内联配置」，不碰 stub、不重启进程、不污染
 * 真实配置：
 *   1. 起 127.0.0.1:8791，返回一份 3 集 CMS（每集指向 stub 已存在的可播
 *      index.m3u8），列表与详情都返回同一份；
 *   2. 用 kind:"text" 内联导入指向它的配置（独立名字，收尾删除）；
 *   3. 首页 → 详情 → 播放第 1 集，然后依次断言：
 *
 *   A. 播放偏好：改音量/倍速 → 500ms 节流后读 localStorage 断言落盘；
 *   B. 自动下一集：对 <video> 派发 ended → 标题副标题变成「第2集」+ 提示条；
 *   C. 跨集沿用：新一集 <video> 的 volume / playbackRate 与上一集一致；
 *   D. Esc 返回：详情页按 Escape 回首页；搜索框聚焦时按 Escape 不回退；
 *   E. 复制错误：制造一条错误条 → 点「复制错误」→ 剪贴板拿到同一段文案。
 *
 * 收尾恢复原 active、删内联配置、关临时 server。
 *
 * 依赖：dev 窗口（CDP 9222）+ stub（8787，只用它现成的 /media/index.m3u8）。
 *   node tools/probes/probe_playback_ux.mjs
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8791;
const CMS_URL = `http://127.0.0.1:${PORT}/cms/multi`;
const CDP = "http://127.0.0.1:9222/json/list";
const MEDIA = "http://127.0.0.1:8787/media/index.m3u8";
const CONFIG_NAME = "probe-playback-ux";

// 3 集，名称与 URL 都由临时 server 提供；$$$ 是线路分隔符（这里只有一条）。
const multiPayload = {
  code: 1,
  // 首页渲染依赖分类列表（stub /cms/vod 的 list 分支也带 class），缺了会导致
  // 首页没有卡片；搜索/detail 则走同一 payload 的 list。
  class: [{ type_id: "1", type_name: "Stub" }],
  list: [
    {
      vod_id: "multi-1",
      vod_name: "UX Probe Series",
      vod_pic: "http://127.0.0.1:8787/poster.jpg",
      vod_remarks: "3集",
      type_name: "Stub",
      vod_play_from: "main",
      // 三集用不同查询串：URL 不同 → resolved 变化 → 换集时 <video> 真正销毁重建，
      // 才能测到「新一集从 localStorage 读回偏好并套用」。相同 URL 不会重建。
      vod_play_url: `第1集$${MEDIA}?ep=1#第2集$${MEDIA}?ep=2#第3集$${MEDIA}?ep=3`,
    },
  ],
  page: 1,
  pagecount: 1,
  limit: 20,
  total: 1,
};

const inlineConfig = JSON.stringify({
  name: CONFIG_NAME,
  sites: [
    {
      key: "ux_multi",
      name: "UX Multi",
      type: 1,
      api: CMS_URL,
      searchable: 1,
      quickSearch: 1,
      filterable: 1,
    },
  ],
});

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(multiPayload));
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, "127.0.0.1", resolve);
});
console.log(`[info] temp CMS server on 127.0.0.1:${PORT}`);

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Runtime.exceptionThrown") {
        const detail = msg.params?.exceptionDetails;
        this.errors.push(detail?.exception?.description || detail?.text || "unknown exception");
        return;
      }
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
      const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 120000);
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
    // reload 之后在途的 evaluate 会撞上「Execution context was destroyed」：
    // 这是探针流程的正常时序（Page.reload 后等新文档），等一秒重投即可。
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.evalOnce(expression);
      } catch (err) {
        if (attempt >= 4 || !/context was destroyed|Not found|no frame/i.test(String(err?.message))) {
          throw err;
        }
        await sleep(1000);
      }
    }
  }
  async evalOnce(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) throw new Error(`eval failed: ${res.exceptionDetails.text}`);
    return res.result?.value;
  }
  close() {
    this.ws.close();
  }
}

async function waitForPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(CDP)).json();
      const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      const page =
        pages.find((t) => t.url.startsWith("http://localhost:1420")) ??
        pages.find((t) => !t.url.startsWith("edge://") && !t.url.startsWith("chrome://"));
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("CDP page target not found");
}

const WAIT = (expression, timeout = 15000) => `(async () => {
  const deadline = Date.now() + ${timeout};
  while (Date.now() < deadline) {
    const value = (() => { ${expression} })();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
})()`;

const CLICK = (label, selector = "button, a") => `(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const text = (n) => (n.textContent || '').trim();
  const target = nodes.find((n) => text(n) === ${JSON.stringify(label)})
              || nodes.find((n) => text(n).includes(${JSON.stringify(label)}));
  if (!target) return 'MISSING';
  target.click();
  return 'CLICKED';
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};

let cdp = null;
let before = null;
const readState = () =>
  cdp.eval(`(async () => {
    const [list, active] = await Promise.all([
      window.__TAURI_INTERNALS__.invoke('config_list'),
      window.__TAURI_INTERNALS__.invoke('config_active'),
    ]);
    return JSON.stringify({ ids: list.map(r => r.id), activeId: active ? active.id : '', activeName: active ? active.name : '' });
  })()`);

try {
  const page = await waitForPage();
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  // 禁用 HTTP 缓存：Vite 的模块转换缓存可能让 reload 命中旧版 PlayerPage，
  // 导致探针在改完源码后仍测到旧逻辑（曾因此误判三次修复无效）。
  try {
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  } catch { /* Network domain 不可用时忽略 */ }
  console.log(`target: ${page.url}`);

  // 自检：确认 dev server 提供的是当前这份源码，而不是 Vite 的旧转换缓存
  // （历史上它让探针测到旧代码、误判修复无效）。
  // 标记**从磁盘源码推导**，不钉产品字符串：内核反复抽模块（usePlayerEngine →
  // playerVolumeFade / playerPosterHold / playerPrefsWriter / playerStallWatchdog），
  // 硬编码字面串每次都要跟着改，还会在「忘了改」时假报 stale。
  const bust = Date.now();
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const readDisk = (rel) => {
    try {
      return readFileSync(resolve(repoRoot, rel), "utf8");
    } catch {
      return "";
    }
  };
  const fetchMod = (rel) =>
    fetch(`http://localhost:1420/${rel}?ux=${bust}`)
      .then((r) => r.text())
      .catch(() => "");
  const diskEngine = readDisk("src/hooks/usePlayerEngine.ts");
  // 引擎在磁盘上引用了哪些同目录模块，被 service 的那份就必须也引用它们；
  // 少一个说明 server 发的是重构前的缓存版本。
  const localDeps = [...diskEngine.matchAll(/from "\.\/([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  const [servedEngine, servedWriter] = await Promise.all([
    fetchMod("src/hooks/usePlayerEngine.ts"),
    fetchMod("src/hooks/playerPrefsWriter.ts"),
  ]);
  const missingDeps = localDeps.filter((name) => !servedEngine.includes(name));
  // 倍速字段隔离这条行为契约：从磁盘写入器里取那行原文，验证 server 发的就是它。
  const isoLine = (readDisk("src/hooks/playerPrefsWriter.ts").split("\n")
    .find((line) => line.includes("rate: video.playbackRate")) ?? "").trim();
  const codeIsFresh =
    localDeps.length > 0 &&
    missingDeps.length === 0 &&
    isoLine.length > 0 &&
    servedWriter.includes(isoLine);
  assert(codeIsFresh, "dev server serves fresh player (derived from disk sources)",
    codeIsFresh ? "" : `stale Vite module cache; restart the dev server (missing=[${missingDeps.join(",")}] iso=${isoLine ? "ok" : "missing"})`);
  if (!codeIsFresh) throw new Error("stale dev module; abort to avoid false product bug report");

  // 桩媒体在 127.0.0.1:8787，而反代默认按 SSRF 闸拒绝 loopback 目标。
  // 不在 `LUMA_PROXY_ALLOW_LOCAL=1` 下跑，清单就会 502，后面三步会报成产品 FAIL。
  // 环境问题要说清原因和修法，按 SKIP 分流，别让它冒充回归。
  const proxyStatus = await cdp.eval("window.__TAURI_INTERNALS__.invoke('proxy_status')").catch(() => null);
  if (proxyStatus && !proxyStatus.allowLocal) {
    console.log("[SKIP] 反代 allowLocal=false：桩媒体 127.0.0.1:8787 会被 SSRF 闸拦成 502。");
    console.log("       请用 LUMA_PROXY_ALLOW_LOCAL=1 起 dev 窗口后重跑（docs/DEVELOPMENT.md 环境变量表）。");
    server.close();
    cdp.ws.close();
    process.exit(0);
  }

  before = JSON.parse(await readState());
  console.log(`[info] before: active=${before.activeName || before.activeId}, configs=${before.ids.length}`);

  // 0. 先把路由归位到首页、并展开侧栏，再 reload。否则 reload 会按当前 hash
  //    重建播放会话（上一个探针可能停在 #/player/…），常驻播放层就带着旧剧的
  //    46 集留在 DOM 里，污染后面所有未 scope 的 .episode 查询（契约：详情页/
  //    选集数的查询必须 scope 到 .content 之外，常驻层不在 .content 内）。
  await cdp.eval("location.hash = '#/'");
  await cdp.eval(`localStorage.setItem('luma:sidebar:v1', '0')`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 15000));

  // 1. 内联导入多集配置。
  const imported = await cdp.eval(`(async () => {
    try {
      const snap = await window.__TAURI_INTERNALS__.invoke('config_import', {
        source: { kind: 'text', value: ${JSON.stringify(inlineConfig)}, name: ${JSON.stringify(CONFIG_NAME)} }
      });
      return JSON.stringify({ ok: true, id: snap.id, name: snap.name, sites: (snap.sites || []).length });
    } catch (e) { return JSON.stringify({ ok: false, err: String(e && e.message || e) }); }
  })()`);
  const imp = JSON.parse(imported);
  assert(imp.ok && imp.sites >= 1, "inline multi-episode config imported", imported);

  // 直接调底层 invoke 绕过了设置页的 handleImported 回调，App 内存里的 sites
  // 仍是旧配置。reload 让它从 config_active（此时是刚导入的内联配置）重新加载。
  await cdp.send("Page.reload", { ignoreCache: true });
  // reload 生效前旧文档仍在：只等 .nav__item 会在旧页面上「通过」，随后的
  // 导航点击被 reload 冲掉。
  // 等页面真正属于新文档（performance.now() 重置）再往下走。
  await cdp.eval(WAIT(
    `return (performance.now() > 1200 && document.querySelector('.nav__item')) ? 'OK' : null;`,
    20000,
  ));
  const activeAfter = await cdp.eval(`window.__TAURI_INTERNALS__.invoke('config_active').then(a => a ? a.name : '')`);
  assert(activeAfter === CONFIG_NAME, "inline config is active after reload", String(activeAfter));

  // 2. 首页 → 详情（首页应渲染出临时 CMS 的片子）。
  //    沉浸式首页推荐流渲染为头图 + poster-rail，分类网格才是
  //    .vod-card；三种形态任一出现即算「首页出了内容」。
  await cdp.eval(`location.hash = '#/'; 'home'`);
  await cdp.eval(WAIT(`return document.querySelector('.page--home') ? 'OK' : null;`, 8000));
  const homeCard = await cdp.eval(
    WAIT(`const c = document.querySelector('.vod-card, .home-hero, .poster-tile'); return c ? c.innerText.split('\\n')[0] : null;`, 25000),
  );
  const homeDiag = await cdp.eval(`JSON.stringify({
    err: document.querySelector('.error-bar__text')?.textContent?.trim() || '',
    sites: (() => { try { return JSON.parse(localStorage.getItem('luma:sites:v1') || '{}').sites?.length ?? -1; } catch { return -2; } })(),
    cards: document.querySelectorAll('.vod-card, .home-hero, .poster-tile').length,
  })`);
  assert(!!homeCard, "home renders temp CMS card", `${homeCard} | diag=${homeDiag}`);
  if (!homeCard) throw new Error("no home card; abort before click");
  // 进详情的入口按形态分：横排 tile / 分类网格点卡进详情；头图整块不可点，
  // 走「立即观看」（直达播放页，详情在会话内挂同一 vod）。
  const enter = await cdp.eval(`(() => {
    const tile = document.querySelector('.vod-card, .poster-tile');
    if (tile) { tile.click(); return 'detail:tile'; }
    const watch = [...document.querySelectorAll('.home-hero button')].find((b) => /立即观看/.test(b.textContent || ''));
    if (watch) { watch.click(); return 'detail:hero-watch'; }
    return 'MISSING';
  })()`);
  assert(enter !== "MISSING", "entered detail/player from home", enter);
  // 两条路径统一以「剧集格出现」为准。episode 一律 scope 到 .content：常驻播放层
  // 不在 .content 内（见 AppShell / layout.css 约定），不 scope 会把常驻层的集数
  // 也数进来（实测 46）。详情页走 .content 里的剧集网格。
  const detailOk = await cdp.eval(
    WAIT(`return document.querySelectorAll('.content .episode').length >= 3 ? 'OK' : null;`, 30000),
  );
  assert(detailOk === "OK", "episodes rendered after enter", String(enter));
  const episodeCount = await cdp.eval(`document.querySelectorAll('.content .episode').length`);
  assert(Number(episodeCount) >= 3, "detail has >=3 episodes", `${episodeCount} episodes`);

  // 3. 播放第 1 集，等 <video> 有真实媒体源。
  await cdp.eval(`document.querySelector('.content .episode').click()`);
  const mediaSrc = await cdp.eval(
    WAIT(`const v = document.querySelector('video'); return v && (v.currentSrc || v.src) ? (v.currentSrc || v.src) : null;`, 40000),
  );
  assert(!!mediaSrc, "player bound a media source", String(mediaSrc).slice(0, 120));
  const ep1 = await cdp.eval(`document.querySelector('.page-title__sub')?.textContent?.trim() || ''`);
  assert(/第1集/.test(ep1), "playing episode 1", ep1);

  // ---- A. 播放偏好记忆：改音量 / 倍速 → 节流落盘 -----------------------------
  // 播放器有 2s 的「倍速初始化静默期」（ArtPlayer 会把新 video 的 playbackRate
  // 覆盖成默认 1，静默期内不认 ratechange）。等静默期过去再模拟用户改倍速，
  // 否则会被当成初始化噪声忽略。
  await sleep(2300);
  const setPrefs = await cdp.eval(`(() => {
    const v = document.querySelector('video');
    if (!v) return 'NO_VIDEO';
    v.volume = 0.35;
    v.dispatchEvent(new Event('volumechange'));
    v.playbackRate = 1.5;
    v.dispatchEvent(new Event('ratechange'));
    return JSON.stringify({ volume: v.volume, rate: v.playbackRate });
  })()`);
  console.log(`[info] applied prefs: ${setPrefs}`);
  // 倍速（ratechange）立即落盘：不等节流窗口就该读到 1.5，证明不再被音量事件吞掉。
  await sleep(120);
  const rateNow = await cdp.eval(`(() => {
    try { return JSON.parse(localStorage.getItem('luma:player:prefs') || '{}').rate; } catch { return null; }
  })()`);
  assert(Math.abs(Number(rateNow) - 1.5) < 0.02, "rate persisted immediately (not swallowed by volume throttle)", String(rateNow));
  // 音量（volumechange）走 500ms 节流 + trailing 补写，等窗口过去再读最终值。
  await sleep(900);
  const stored = await cdp.eval(`localStorage.getItem('luma:player:prefs') || ''`);
  let storedObj = {};
  try { storedObj = JSON.parse(stored) || {}; } catch { /* 空或损坏 */ }
  assert(
    Math.abs(Number(storedObj.volume) - 0.35) < 0.02 && Math.abs(Number(storedObj.rate) - 1.5) < 0.02,
    "volume/rate persisted to localStorage",
    stored,
  );

  // ---- B. 自动下一集：派发 ended → 标题副标题变成「第2集」+ 提示条 ----------
  await cdp.eval(`(() => {
    const v = document.querySelector('video');
    v && v.dispatchEvent(new Event('ended'));
    return true;
  })()`);
  const ep2 = await cdp.eval(
    WAIT(`const s = document.querySelector('.page-title__sub')?.textContent?.trim() || ''; return /第2集/.test(s) ? s : null;`, 25000),
  );
  assert(!!ep2, "auto-advanced to episode 2", String(ep2));
  const tip = await cdp.eval(
    WAIT(`const t = [...document.querySelectorAll('[data-sonner-toast]')].map((x) => x.textContent).join(' ') || ''; return /自动播放下一集/.test(t) ? t.slice(0, 40) : null;`, 10000),
  );
  assert(!!tip, "auto-next tip shown", String(tip));

  // ---- C. 跨集沿用：新一集 <video> 的音量 / 倍速与上一集一致 ----------------
  // 换集会销毁重建 ArtPlayer + hls.js，<video> 是全新元素；宽限到 60s 等它带 src。
  // 注意：WAIT 已用 `(() => { <expr> })()` 包了一层，<expr> 里必须直接写语句 +
  // return；再嵌套一个 IIFE 会让 return 出不了外层，永远拿到 undefined。
  // 先等新一集 video 带 src（换集时 ArtPlayer 销毁重建，最多给 60s）。
  await cdp.eval(
    WAIT(`const v = document.querySelector('video'); return v && (v.currentSrc || v.src) ? 'OK' : null;`, 60000),
  );
  // 再等倍速被纠正回记忆值：PlayerPage 在初始化静默期内会即时纠正 ArtPlayer
  // 的倍速重置，另有 1.2s 延迟重放兜底。上限 5s，超时则带实际值由断言暴露。
  await cdp.eval(
    WAIT(`const v = document.querySelector('video'); return v && Math.abs(v.playbackRate - 1.5) < 0.02 ? 'OK' : null;`, 5000),
  );
  const carried = await cdp.eval(`(() => {
    const v = document.querySelector('video');
    if (!v) return null;
    return JSON.stringify({ volume: Number(v.volume.toFixed(2)), rate: Number(v.playbackRate.toFixed(2)) });
  })()`);
  let carriedObj = null;
  try { carriedObj = JSON.parse(carried || "null"); } catch { /* 未就绪 */ }
  const carriedDiag = await cdp.eval(`JSON.stringify({
    videos: document.querySelectorAll('video').length,
    src: (() => { const v = document.querySelector('video'); return v ? (v.currentSrc || v.src || '').slice(0, 60) : ''; })(),
    err: document.querySelector('.error-bar__text')?.textContent?.trim() || '',
    sub: document.querySelector('.page-title__sub')?.textContent?.trim() || '',
  })`);
  assert(
    carriedObj && Math.abs(Number(carriedObj.volume) - 0.35) < 0.02 && Math.abs(Number(carriedObj.rate) - 1.5) < 0.02,
    "episode 2 inherits volume/rate",
    `${carried} | diag=${carriedDiag}`,
  );
  // ---- D. Esc 返回：播放页 → Esc 回详情 → Esc 回首页 -----------------------
  await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  const backToDetail = await cdp.eval(
    WAIT(`return document.body.innerText.includes('播放线路') ? 'OK' : null;`, 15000),
  );
  assert(backToDetail === "OK", "Esc from player returns to detail", String(backToDetail));
  await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  const backToHome = await cdp.eval(
    WAIT(`const title = document.querySelector('.page-title')?.textContent?.trim() || '';
      const onDetail = document.body.innerText.includes('播放线路');
      return title.startsWith('首页') && !onDetail ? 'OK' : null;`, 15000),
  );
  const escDiag = await cdp.eval(`JSON.stringify({
    title: document.querySelector('.page-title')?.textContent?.trim() || '',
    onDetail: document.body.innerText.includes('播放线路'),
    episodes: document.querySelectorAll('.content .episode').length,
    url: location.href,
  })`);
  assert(backToHome === "OK", "Esc from detail returns to home", `${backToHome} | diag=${escDiag}`);

  // 输入框里按 Esc 不应触发返回（先切到搜索页并在输入框聚焦）。
  await cdp.eval(CLICK("搜索", ".nav__item"));
  const searchInput = await cdp.eval(
    WAIT(`const i = document.querySelector('.search-bar input.input'); return i ? 'OK' : null;`, 15000),
  );
  assert(searchInput === "OK", "search page opened", String(searchInput));
  await cdp.eval(`(() => {
    const i = document.querySelector('.search-bar input.input');
    i.focus();
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return document.activeElement === i;
  })()`);
  await sleep(300);
  const stillSearch = await cdp.eval(`!!document.querySelector('.search-bar input.input')`);
  assert(stillSearch, "Esc inside input does not navigate back");

  // ---- E. 复制错误：清空关键词点搜索 → 错误条 → 复制 → 剪贴板 ---------------
  await cdp.eval(`(() => {
    const i = document.querySelector('.search-bar input.input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(i, '');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await cdp.eval(CLICK("搜索", ".search-bar button"));
  const errText = await cdp.eval(
    WAIT(`const el = document.querySelector('.error-bar__text'); return el ? el.textContent.trim() : null;`, 10000),
  );
  assert(!!errText, "error bar visible on empty query", String(errText));

  // clipboard API 需要 user activation：b.click() 是脚本触发、没有手势，writeText
  // 会被拒。用 CDP 真实鼠标事件点在按钮中心，模拟用户点击后再验证。
  // 入场动画（bar-in 260ms）期间节点有 ≤6px 位移，测标必须等动画落定，
  // 否则坐标打偏、点不到按钮。
  await sleep(500);
  // 先授予剪贴板权限再点：writeText 被权限拒时按钮不会进入 ok/failed 态，
  // 「反馈出现」与「内容正确」两条断言都建立在权限就位之上。
  try {
    await cdp.send("Browser.grantPermissions", {
      origin: "http://localhost:1420",
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
  } catch (e) {
    console.log(`[info] grant clipboard permission failed: ${e && e.message || e}`);
  }
  const box = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('.error-bar__actions button')]
      .find(x => (x.getAttribute('aria-label') || '').includes('复制'));
    if (!b) return 'MISSING';
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`);
  assert(box !== "MISSING", "copy-error button present", String(box));
  if (box !== "MISSING") {
    // 短轮询只用来容忍错误条入场动画 / 临时 toast（≤数秒会落定）。每拍重新测坐标，
    // 命中目标确实是按钮或其子孙才点；若被「常驻播放器 idle 控制条」长期盖住，
    // 这里会如实失败——那是产品问题（见报告：.player-host.is-idle 的
    // pointer-events:none / visibility:hidden 没穿过 ArtPlayer 自己的
    // .art-controls{pointer-events:auto;visibility:visible}，后台播放器那条
    // opacity:0 的控制栏会抢走其它页面的点击），不在探针里绕过。
    let clicked = false;
    let lastCovered = "";
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const hit = await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('.error-bar__actions button')]
          .find((x) => (x.getAttribute('aria-label') || '').includes('复制'));
        if (!b) return 'VANISHED';
        const r = b.getBoundingClientRect();
        const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
        const el = document.elementFromPoint(x, y);
        if (el !== b && !b.contains(el)) {
          const who = el && el.closest && el.closest('.player-host') ? 'idle-player-controls' : 'other';
          return 'COVERED:' + who + ':' + (el ? el.tagName + '.' + String(el.className).slice(0, 30) : 'null');
        }
        return JSON.stringify({ x, y });
      })()`);
      if (hit.startsWith("{")) {
        const { x, y } = JSON.parse(hit);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
        await sleep(80);
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        clicked = true;
        break;
      }
      if (hit === "VANISHED") {
        console.log(`[info] copy button vanished before click`);
        break;
      }
      lastCovered = hit;
      await sleep(400);
    }
    if (!clicked) console.log(`[info] copy click blocked within 6s by: ${lastCovered}`);
  }
  // 按钮初始就是 data-copy-state="idle"，必须等它变成 ok/failed 才算捕获到反馈。
  const copyState = await cdp.eval(
    WAIT(`const b = document.querySelector('.error-bar__actions button');
      if (!b) return null;
      const s = b.getAttribute('data-copy-state');
      return s === 'ok' || s === 'failed' ? s : null;`, 8000),
  );
  assert(copyState === "ok" || copyState === "fallback" || copyState === "failed",
    "copy produced a state feedback", String(copyState));
  assert(copyState !== "failed", "copy did not report failure", String(copyState));

  // 授予剪贴板读权限后读回完整文案（读写同源、内容应一字不差）。
  // 权限已在点击前授予，这里直接读。
  let clip = "";
  try {
    clip = (await cdp.eval(`navigator.clipboard.readText().catch(() => '')`)) || "";
  } catch { /* 权限被拒 */ }
  if (copyState === "ok" && clip) {
    assert(clip === errText, "clipboard holds the exact error text", JSON.stringify(clip));
  } else if (copyState === "ok") {
    console.log("[info] clipboard read-back blocked; skipped content assertion (button state proves write path)");
  } else {
    // 复制按钮没真正成功（多半是被上面的覆盖层挡住点不到）：剪贴板里是别处的旧内容，
    // 读回对比无意义。该情形已由「copy produced a state feedback」主断言如实报红。
    console.log(`[info] clipboard read-back skipped (copyState=${copyState}; 未真正写入剪贴板)`);
  }

  // ---- 无未捕获异常 ---------------------------------------------------------
  assert(cdp.errors.length === 0, "no uncaught page exceptions", cdp.errors.slice(0, 2).join(" | "));
  await cdp.shot?.("playback-ux");
} catch (err) {
  console.log(`[FAIL] probe threw: ${err && err.stack ? err.stack : err}`);
  failures += 1;
} finally {
  // 收尾：恢复 active、删内联配置、关 server、关 CDP。
  if (cdp && before) {
    try {
      const after = JSON.parse(await readState());
      const created = after.ids.filter((id) => !before.ids.includes(id));
      for (const id of created) {
        await cdp.eval(
          `window.__TAURI_INTERNALS__.invoke('config_remove', { id: ${JSON.stringify(id)} }).then(()=>'OK').catch(()=>'ERR')`,
        );
      }
      if (before.activeId) {
        await cdp.eval(
          `window.__TAURI_INTERNALS__.invoke('config_activate', { id: ${JSON.stringify(before.activeId)} }).then(()=>'OK').catch(()=>'ERR')`,
        );
      }
      // 探针内联源播过的片子会在历史里留一条指向已删除配置的悬空记录，一并清掉，
      // 别污染用户的观看历史（与 probe_flv 同口径）。
      const histClean = await cdp.eval(`(async () => {
        const history = await window.__TAURI_INTERNALS__.invoke('history_list');
        let n = 0;
        for (const item of history) {
          if (item.name === 'UX Probe Series') {
            await window.__TAURI_INTERNALS__.invoke('history_remove', { siteKey: item.siteKey, vodId: item.vodId });
            n += 1;
          }
        }
        return n;
      })().catch(() => -1)`);
      console.log(`[info] cleanup: removed ${created.length} config(s), ${histClean} history entit(y/ies), active → ${before.activeName || before.activeId}`);
    } catch (e) {
      console.log(`[warn] cleanup failed: ${e && e.message || e}`);
    }
    cdp.close();
  }
  await new Promise((resolve) => server.close(resolve));
  console.log(`[info] temp server closed`);
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL: ${failures} step(s)`}`);
process.exit(failures === 0 ? 0 : 1);
