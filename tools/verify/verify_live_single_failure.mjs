#!/usr/bin/env node
/**
 * 直播「解析失败只出现一次」验收（CDP，模块级故障注入）：
 *
 * 用户要求把「顶部横幅 + 画面中央卡片」写同一句话的重复合成一处。合并规则是
 * **按有没有画面二选一**：
 *   A. 没有可播画面（首进频道 / 旧实例已卸载）→ 舞台卡片承载主文案 + 归因；
 *   B. 旧流还在播（换线失败时刻意保留实例）→ 顶部横幅，卡片不出现。
 *
 * 注入方式：`resolve_play` 走 Tauri IPC（`window.__TAURI_INTERNALS__.invoke`
 * 是只读属性，改不动），所以在响应阶段改写 `/src/lib/invoke.ts` 这个模块，
 * 给 `api.resolvePlay` 包一层：`window.__failResolve !== false` 时以
 * 「源站超时」拒绝。这样失败来自真实调用点，走的是产品代码的完整错误链路。
 *
 * 用法：node tools/verify/verify_live_single_failure.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";

const FAIL_BODY = `
;(() => {
  if (typeof api !== "object" || !api || typeof api.resolvePlay !== "function") return;
  if (api.__faultInjected) return;
  const orig = api.resolvePlay.bind(api);
  api.__faultInjected = true;
  if (window.__failResolve === undefined) window.__failResolve = true;
  api.resolvePlay = (req) =>
    window.__failResolve === false
      ? orig(req)
      : Promise.reject({
          code: "SITE_TIMEOUT",
          message: "源站未响应：解析播放地址超时（12000ms）",
        });
})();
`;

mkdirSync("tools/.out/shots", { recursive: true });

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
await new Promise((r, j) => {
  ws.addEventListener("open", r, { once: true });
  ws.addEventListener("error", j, { once: true });
});

let patched = 0;
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
    return;
  }
  if (m.method === "Fetch.requestPaused") {
    void handlePaused(m.params);
  }
});

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${method} timeout`)), 120000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      if (m.error) rej(new Error(`${method}: ${JSON.stringify(m.error)}`));
      else res(m);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function handlePaused(p) {
  const url = p.request?.url ?? "";
  const isModule = url.includes("/src/lib/invoke.ts");
  if (!isModule || !p.responseStatusCode) {
    await send("Fetch.continueRequest", { requestId: p.requestId }).catch(async () => {
      await send("Fetch.continueResponse", { requestId: p.requestId }).catch(() => {});
    });
    return;
  }
  try {
    const got = await send("Fetch.getResponseBody", { requestId: p.requestId });
    const raw = got.result.base64Encoded
      ? Buffer.from(got.result.body, "base64").toString("utf8")
      : got.result.body;
    const body = raw + FAIL_BODY;
    patched += 1;
    await send("Fetch.fulfillRequest", {
      requestId: p.requestId,
      responseCode: 200,
      responseHeaders: [
        { name: "Content-Type", value: "text/javascript; charset=utf-8" },
        { name: "Cache-Control", value: "no-store" },
      ],
      body: Buffer.from(body, "utf8").toString("base64"),
    });
  } catch (err) {
    console.log(`[warn] 注入失败，放行原始模块：${err.message}`);
    await send("Fetch.continueResponse", { requestId: p.requestId }).catch(() => {});
  }
}

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  }
  return r.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(name) {
  const s = await send("Page.captureScreenshot", { format: "jpeg", quality: 88 });
  const path = `tools/.out/shots/${name}.jpg`;
  writeFileSync(path, Buffer.from(s.result.data, "base64"));
  console.log(`[shot] ${path}`);
}

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Fetch.enable", {
  patterns: [{ urlPattern: "*/src/lib/invoke.ts*", requestStage: "Response" }],
});

const SAMPLE = `(() => {
  const bar = [...document.querySelectorAll('.error-bar')].find((el) =>
    el.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
  );
  const card = document.querySelector('.player-status.is-error');
  const video = [...document.querySelectorAll('video')].find((v) =>
    v.checkVisibility({ visibilityProperty: true }),
  );
  const pick = (root, sel) => (root?.querySelector(sel)?.textContent || '').trim();
  return {
    bar: bar ? pick(bar, '.error-bar__text') : '',
    barHint: bar ? pick(bar, '.error-bar__hint') : '',
    cardTitle: card ? pick(card, '.player-status__title') : '',
    cardDesc: card ? pick(card, '.player-status__desc') : '',
    cardAction: card ? pick(card, '.player-status__action') : '',
    injected: window.__failResolve === undefined ? 'missing' : String(window.__failResolve),
    video: video ? { rs: video.readyState, w: video.videoWidth, paused: video.paused } : null,
  };
})()`;

const channelCount = () =>
  evaluate(`document.querySelectorAll('.live-rail__item, .channel-item, [data-channel]').length`);

async function enterLive() {
  await evaluate(`location.hash = '#/live'`);
  const end = Date.now() + 40000;
  while (Date.now() < end) {
    if ((await channelCount()) > 0) return;
    await sleep(400);
  }
  throw new Error("直播频道列表未加载");
}

const clickChannel = (idx) =>
  evaluate(`(() => {
    const items = [...document.querySelectorAll('.live-rail__item, .channel-item, [data-channel]')];
    const el = items[${idx}];
    if (!el) return false;
    el.click();
    return true;
  })()`);

/** 轮询采样直到条件成立；超时返回最后一次采样（调用方自己判定）。 */
async function waitFor(pred, ms, label) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    last = await evaluate(SAMPLE);
    if (pred(last)) return last;
    await sleep(300);
  }
  console.log(`[warn] 等待超时：${label}；最后一次 ${JSON.stringify(last)}`);
  return last;
}

const report = [];
const check = (name, ok, detail) => {
  report.push({ name, ok, detail });
  console.log(`${ok ? "  ok" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// ---------- A. 没有画面 → 舞台卡片 ----------
console.log("\n== A. 解析失败且没有画面（首进频道） ==");
await send("Page.reload");
await sleep(1500);
console.log(`  已注入模块：${patched} 次`);
await enterLive();
let a = await waitFor((x) => x.cardTitle.length > 0 || (x.video?.w ?? 0) > 0, 25000, "首个频道结论");
if (!a.cardTitle && !(a.video?.w > 0)) {
  await clickChannel(0);
  a = await waitFor((x) => x.cardTitle.length > 0 || (x.video?.w ?? 0) > 0, 25000, "点击后的结论");
}
if (a.cardTitle) {
  check("结论落在画面中央的卡片上", true, `card="${a.cardTitle}"`);
  check("同一时刻顶部没有同义横幅", !a.bar, `bar="${a.bar || "—"}"`);
  check("卡片副行是归因/下一步，不是原始报错", /刷新|换/.test(a.cardDesc), `desc="${a.cardDesc}"`);
  check(
    "卡片文案来自归类，没有内部名/原始超时串",
    !/resolve_play|SITE_TIMEOUT|12000ms/.test(`${a.cardTitle}${a.cardDesc}`),
    `title="${a.cardTitle}" desc="${a.cardDesc}"`,
  );
  await shot("live-single-failure-card");
} else {
  check("首进频道出现解析失败卡片", false, `实际拿到 ${JSON.stringify(a)}`);
}

// ---------- B. 旧流还在播 → 顶部横幅 ----------
console.log("\n== B. 解析失败但旧画面还在播（换台失败） ==");
await evaluate(`window.__failResolve = false`);
let playing = null;
for (let i = 0; i < 5 && !playing; i += 1) {
  await clickChannel(i);
  const s = await waitFor((x) => (x.video?.w ?? 0) > 0 && (x.video?.rs ?? 0) >= 2, 25000, "出画");
  if ((s?.video?.w ?? 0) > 0 && (s.video.rs ?? 0) >= 2) playing = s;
}
if (!playing) {
  check("恢复出画（B 场景前提）", false, "5 次换台内没有出画，B 未验证");
} else {
  console.log(`  已出画：${playing.video.w}px / rs=${playing.video.rs}`);
  await waitFor((x) => !x.bar, 12000, "横幅清场");
  await evaluate(`window.__failResolve = true`);
  const n = await channelCount();
  await clickChannel(n > 1 ? 1 : 0);
  const b = await waitFor((x) => x.bar.length > 0, 30000, "换台失败的结论");
  check("换台失败给出了结论", b.bar.length > 0, `bar="${b.bar || "—"}"`);
  check("此时卡片不出现（旧流还在播，不能盖住画面）", !b.cardTitle, `card="${b.cardTitle || "—"}"`);
  check(
    "横幅是归类结论（不是原始报错）",
    /源站|超时|播放地址|线路/.test(b.bar) && !/resolve_play|SITE_TIMEOUT/.test(b.bar),
    `bar="${b.bar}"`,
  );
  const tail = await evaluate(SAMPLE);
  console.log(
    `  换台失败后 video=${tail.video ? `${tail.video.w}px/rs=${tail.video.rs}/${tail.video.paused ? "paused" : "play"}` : "—"}`,
  );
  await shot("live-single-failure-banner");
}

// 收尾：关掉注入并恢复真实解析，别把 app 留在坏状态。
await evaluate(`window.__failResolve = false`);
await send("Fetch.disable");
await send("Network.setCacheDisabled", { cacheDisabled: false });

const bad = report.filter((r) => !r.ok);
console.log(`\n=== 结论：${report.length - bad.length}/${report.length} 通过 ===`);
for (const r of bad) console.log(`FAIL ${r.name} — ${r.detail}`);
console.log(bad.length === 0 ? "PASS" : "FAIL");
ws.close();
process.exit(bad.length === 0 ? 0 : 1);
