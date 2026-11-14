#!/usr/bin/env node
/**
 * FLV 播放回归：验证 mpegts.js 真正把 FLV 解码出画，而不是把 flv 直接塞给 <video>。
 *
 * 1. 导入只含 FLV 片源的桩配置（/config-flv.json，单集指向 /media/sample.flv）；
 * 2. 首页 → 详情 → 播放第 1 集；
 * 3. 断言 <video> 有真实帧（videoWidth > 0、currentTime 在走）、src 是 blobs
 *    （MSE 管线，说明走的是 mpegts.js 而不是原生解码）；
 * 4. 断言没有「FLV 播放失败 / 播放器加载失败」这类错误条；
 * 5. 恢复原来的 active 配置。
 *
 * 依赖：dev 窗口（CDP 9222）+ python tests/stub_server.py（含 sample.flv 素材）。
 *   node tools/probes/probe_flv.mjs
 */
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
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`eval failed: ${res.exceptionDetails.text}`);
    }
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
      const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
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

const CLICK = (label, selector = "button") => `(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const text = (el) => (el.textContent || '').trim();
  const target = nodes.find((el) => text(el) === ${JSON.stringify(label)})
    || nodes.find((el) => text(el).includes(${JSON.stringify(label)}));
  if (!target) return 'MISSING';
  target.click();
  return 'CLICKED';
})()`;

/** 播放器体检：是否有真实帧、是否走 MSE、当前时间是否在推进。 */
const VIDEO_STATE = `(() => {
  const v = document.querySelector('.player-art video') || document.querySelector('video');
  if (!v) return JSON.stringify({ ok: false, reason: 'no video element' });
  return JSON.stringify({
    ok: v.videoWidth > 0 && v.videoHeight > 0,
    w: v.videoWidth,
    h: v.videoHeight,
    t: Number(v.currentTime.toFixed(2)),
    paused: v.paused,
    readyState: v.readyState,
    srcScheme: (v.currentSrc || v.src || '').split(':')[0],
    error: v.error ? v.error.code : null,
    fallback: !!document.querySelector('.player-fallback'),
    errors: [...document.querySelectorAll('.error-bar')].map((el) => el.innerText.trim()).slice(0, 3),
  });
})()`;

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CONFIG = "http://127.0.0.1:8787/config-flv.json";
const PROBE_NAME = "FLV 探针配置";

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
console.log(`target: ${page.url}`);

let previousActive = "";
try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1200);
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000))) === "OK",
    "app rendered",
  );

  // 记住原配置，结束时恢复，避免探针把用户的 active 换掉。
  previousActive = await cdp.eval(
    `window.__TAURI_INTERNALS__.invoke('config_active').then((s) => (s ? s.id : ''))`,
  );
  console.log(`[info] previous active: ${previousActive}`);

  const imported = await cdp.eval(`(async () => {
    try {
      const snap = await window.__TAURI_INTERNALS__.invoke('config_import', {
        source: { kind: 'url', value: ${JSON.stringify(CONFIG)}, name: ${JSON.stringify(PROBE_NAME)} },
      });
      return JSON.stringify({ id: snap.id, name: snap.name, sites: snap.sites.length, enabled: snap.sites.filter((s) => s.enabled).length });
    } catch (err) {
      return 'ERR:' + JSON.stringify(err);
    }
  })()`);
  console.log(`[info] imported: ${imported}`);
  assert(typeof imported === "string" && imported.startsWith("{"), "flv config imported", String(imported));
  const flvConfigId = JSON.parse(imported).id;

  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000))) === "OK",
    "reloaded with flv config",
  );

  // 首页 → 打开唯一影片
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.vod-card') ? 'OK' : null;", 25000))) === "OK",
    "home list rendered",
  );
  assert(
    (await cdp.eval(`(() => { const el = document.querySelector('.vod-card'); if (!el) return 'MISSING'; el.click(); return 'CLICKED'; })()`)) ===
      "CLICKED",
    "open first vod",
  );
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.detail-title') ? 'OK' : null;", 25000))) === "OK",
    "detail rendered",
  );
  // 详情页按钮文案会随历史变化（「▶ 播放第 1 集」/「▶ 继续播放 第 1 集（0:03）」），
  // 按包含「播放」且不是外部播放来点，避免探针被历史记录带偏。
  const playClick = await cdp.eval(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const text = (el) => (el.textContent || '').trim();
    const target = buttons.find((el) => text(el).includes('播放') && !text(el).includes('外部'));
    if (!target) return 'MISSING';
    target.click();
    return 'CLICKED';
  })()`);
  assert(playClick === "CLICKED", "click 播放", playClick);

  const state = JSON.parse(
    (await cdp.eval(WAIT(`const s = JSON.parse(${VIDEO_STATE}); return (s.ok && s.t > 0.2) || s.error || s.fallback ? JSON.stringify(s) : null;`, 40000))) ||
      "{}",
  );
  console.log(`[info] video: ${JSON.stringify(state)}`);
  assert(state.ok === true, "FLV decoded real frames", JSON.stringify(state));
  assert((state.w ?? 0) > 0 && (state.h ?? 0) > 0, "video dimensions reported", `${state.w}x${state.h}`);
  // MSE 的 src 一定是 blob:；如果是 http:// 说明 flv 被直塞给 <video>（老 bug 回归）。
  assert(state.srcScheme === "blob", "plays through MSE (mpegts.js), not <video> src", String(state.srcScheme));
  assert(state.error == null, "no media element error", String(state.error));
  assert(state.fallback !== true, "no fallback panel", String(state.fallback));
  assert(
    !(state.errors || []).some((text) => /FLV|播放器加载失败/.test(text)),
    "no FLV error bar",
    JSON.stringify(state.errors),
  );

  const advanced = JSON.parse(
    (await cdp.eval(WAIT(
      `const s = JSON.parse(${VIDEO_STATE}); return s.t > ${Math.max(0.5, (state.t ?? 0) + 0.3)} ? JSON.stringify(s) : null;`,
      12000,
    ))) || "{}",
  );
  console.log(`[info] video advanced: ${JSON.stringify(advanced)}`);
  assert(advanced.t > (state.t ?? 0), "playback is progressing", `${state.t} -> ${advanced.t}`);
} catch (err) {
  failures += 1;
  console.error(`[FAIL] probe crashed: ${err && err.message ? err.message : err}`);
  if (cdp.errors.length) {
    console.error(`[info] page errors: ${JSON.stringify(cdp.errors.slice(0, 3))}`);
  }
} finally {
  // 恢复原配置：探针导入的 flv 配置用完即删，active 回到原值。
  try {
    if (previousActive) {
      await cdp.eval(
        `window.__TAURI_INTERNALS__.invoke('config_activate', { id: ${JSON.stringify(previousActive)} }).then(() => 'OK').catch(() => 'ERR')`,
      );
    }
    const removed = await cdp.eval(`(async () => {
      const rows = await window.__TAURI_INTERNALS__.invoke('config_list');
      const probe = rows.find((r) => r.name === ${JSON.stringify(PROBE_NAME)});
      if (probe) await window.__TAURI_INTERNALS__.invoke('config_remove', { id: probe.id });
      // 探针播过的片子会在历史里留一条，一并清掉，别污染用户的观看记录。
      const history = await window.__TAURI_INTERNALS__.invoke('history_list');
      for (const item of history) {
        if (item.name === 'Stub FLV Movie') {
          await window.__TAURI_INTERNALS__.invoke('history_remove', { siteKey: item.siteKey, vodId: item.vodId });
        }
      }
      return probe ? 'OK' : 'NONE';
    })().catch((e) => 'ERR:' + JSON.stringify(e))`);
    console.log(`[info] cleanup: ${removed}`);
  } catch (err) {
    console.error(`[warn] cleanup failed: ${err && err.message ? err.message : err}`);
  }
  cdp.close();
}

console.log(failures === 0 ? "\nPASS flv playback" : `\nFAILED ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
