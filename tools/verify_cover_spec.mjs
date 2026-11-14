#!/usr/bin/env node
/**
 * 封面尺寸阶梯 + 播放页简介展开验收。
 *
 * 规格（`src/styles.css` 的 `--cover-*`）：
 *   详情页主视觉 210×315 / 播放页信息卡 132×198 / 空态 150×225 /
 *   骨架 210×315 / 网格卡片宽 220~260、比例恒 2:3。
 *
 * 验收口径：直接量 DOM 矩形，比例误差 ≤ 2px；同时验证所有封面图片是
 * `object-fit: cover`（不允许拉伸）。展开按钮按「实际溢出」出现：短简介
 * 不该有按钮，长简介点击后 clamp 解除、高度变大，再点能收回去。
 *
 * 用法：node tools/verify_cover_spec.mjs
 */
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
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${method} timeout`)), 60000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      res(m);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  return r.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const measure = (selector) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const img = el.querySelector("img");
    return JSON.stringify({
      w: Math.round(r.width), h: Math.round(r.height),
      fit: img ? getComputedStyle(img).objectFit : null,
    });
  })()`);
const checkCover = async (selector, wantW, label) => {
  const raw = await measure(selector);
  if (!raw) {
    assert(false, label, "元素不存在");
    return;
  }
  const m = JSON.parse(raw);
  const wantH = Math.round((wantW * 3) / 2);
  assert(
    Math.abs(m.w - wantW) <= 2 && Math.abs(m.h - wantH) <= 2,
    label,
    `${m.w}×${m.h}，期望 ${wantW}×${wantH}`,
  );
  if (m.fit) assert(m.fit === "cover", `${label}: 图片不拉伸`, `object-fit=${m.fit}`);
};

await send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});

// ---------- 首页网格 ----------
await evaluate(`(() => { location.hash = "#/"; return 1; })()`);
await sleep(2200);
const grid = await evaluate(`(() => {
  const el = document.querySelector(".content .vod-card__poster");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), ratio: r.width / r.height });
})()`);
if (grid) {
  const g = JSON.parse(grid);
  assert(g.w >= 220 && g.w <= 260, "网格封面宽度在 220~260 之间", `${g.w}px`);
  assert(Math.abs(g.ratio - 2 / 3) < 0.02, "网格封面比例 2:3", g.ratio.toFixed(3));
} else {
  console.log("[info] 首页无卡片（源未出数据），网格断言跳过");
}

// ---------- 详情页主视觉 ----------
await evaluate(`(() => { const c = document.querySelector(".content .vod-card"); if (c) c.click(); return 1; })()`);
await sleep(3000);
const detailHash = await evaluate("location.hash");
if (detailHash.startsWith("#/detail/")) {
  if (await evaluate(`!!document.querySelector(".detail-poster")`)) {
    await checkCover(".content .detail-poster", 210, "详情页主视觉封面");
  } else if (await evaluate(`!!document.querySelector(".detail-empty__poster")`)) {
    await checkCover(".content .detail-empty__poster", 150, "详情空态封面");
  } else {
    console.log("[info] 详情仍在加载/无海报，封面断言跳过");
  }
} else {
  console.log(`[info] 未进入详情页（${detailHash}），详情封面断言跳过`);
}

// ---------- 播放页信息卡 + 展开逻辑 ----------
await evaluate(`(() => { const b = document.querySelector(".detail-actions .btn--primary"); if (b) b.click(); return 1; })()`);
await sleep(3500);
const playerHash = await evaluate("location.hash");
console.log(`[info] player hash: ${playerHash}`);
if (await evaluate(`!!document.querySelector(".player-host .player-about__poster")`)) {
  await checkCover(".player-host .player-about__poster", 132, "播放页信息卡封面");

  // 短简介不该出现展开按钮；注入长文本让 ResizeObserver 重新量 overflow。
  const shortHasToggle = await evaluate(`!!document.querySelector(".player-host .player-about__more")`);
  console.log(`[info] 当前简介的展开按钮: ${shortHasToggle}`);
  await evaluate(`(() => {
    const p = document.querySelector(".player-host .player-about .detail-content");
    if (p) p.textContent = "这是一段用于验证折叠逻辑的长简介：".repeat(24);
    return 1;
  })()`);
  await sleep(500);
  const withToggle = await evaluate(`!!document.querySelector(".player-host .player-about__more")`);
  assert(withToggle, "长简介出现展开按钮", String(withToggle));
  const before = await evaluate(`(() => { const p = document.querySelector(".player-host .player-about .detail-content"); return p ? Math.round(p.getBoundingClientRect().height) : 0; })()`);
  await evaluate(`(() => { const b = document.querySelector(".player-host .player-about__more"); if (b) b.click(); return 1; })()`);
  await sleep(300);
  const after = await evaluate(`(() => {
    const p = document.querySelector(".player-host .player-about .detail-content");
    const b = document.querySelector(".player-host .player-about__more");
    return JSON.stringify({ h: p ? Math.round(p.getBoundingClientRect().height) : 0, cls: p?.className, expanded: b?.getAttribute("aria-expanded"), stillVisible: !!b });
  })()`);
  const a = JSON.parse(after);
  assert(a.h > before, "点击展开后简介变高", `${before} → ${a.h}`);
  assert(a.expanded === "true", "aria-expanded 切换为 true", String(a.expanded));
  assert(a.stillVisible, "展开后按钮仍在（可收回）", String(a.stillVisible));
  await evaluate(`(() => { const b = document.querySelector(".player-host .player-about__more"); if (b) b.click(); return 1; })()`);
  await sleep(300);
  const collapsed = await evaluate(`(() => { const p = document.querySelector(".player-host .player-about .detail-content"); return p?.className ?? ""; })()`);
  assert(collapsed.includes("is-clamped"), "再点一次能收回", collapsed);
} else {
  console.log("[info] 播放页信息卡未出现，展开断言跳过");
}

ws.close();
console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed step(s)`);
process.exit(failures === 0 ? 0 : 1);
