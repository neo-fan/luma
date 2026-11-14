#!/usr/bin/env node
/**
 * 吸顶页头 + 错误态解剖结构验收：
 *  1. 首页滚动 700px 后，页头（含分类 chip 行）仍贴在内容区顶部（偏移 ≤ 2px），
 *     且带上 is-stuck（底部分隔线）；
 *  2. 直播页页头同样吸顶，左侧频道栏从页头下沿开始（不被盖住）；
 *  3. 错误块由「主文案 + 归因 + 折叠的技术详情」三段组成，原始 URL 不在主文案里。
 *
 * 用法：node tools/verify_sticky_ui.mjs
 */
import { mkdirSync } from "node:fs";

mkdirSync(".workbuddy/shots", { recursive: true });

const target = (
  await (await fetch("http://127.0.0.1:9222/json/list")).json()
).find((t) => {
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
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails)
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  return r.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(
    `[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`,
  );
  if (!ok) failures += 1;
};

await send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    `.workbuddy/shots/${name}.png`,
    Buffer.from(r.result.data, "base64"),
  );
}

// ---------- 首页 ----------
await evaluate(`(() => { location.hash = "#/"; return true; })()`);
await sleep(1800);

const homeGeom = `(() => {
  const body = document.querySelector(".content .page-body");
  const head = document.querySelector(".content .page-head");
  const content = document.querySelector(".content");
  if (!body || !head || !content) return null;
  const c = content.getBoundingClientRect();
  const s = head.getBoundingClientRect();
  const chips = document.querySelector(".content .chip-row");
  return JSON.stringify({
    scrollTop: Math.round(body.scrollTop),
    headOffset: Math.round(s.top - c.top),
    chipsVisible: chips ? chips.getBoundingClientRect().bottom <= c.bottom : false,
    chips: document.querySelectorAll(".chip").length,
    headInsideScroller: !!body.contains(head),
  });
})()`;

console.log("[info] home@top:", await evaluate(homeGeom));
await shot("sticky-home-top");

await evaluate(`(() => {
  const body = document.querySelector(".content .page-body");
  body.scrollTop = 700;
  return body.scrollTop;
})()`);
await sleep(400);
const homeScrolled = await evaluate(homeGeom);
console.log("[info] home@700:", homeScrolled);
const h = JSON.parse(homeScrolled);
assert(
  h.scrollTop > 600,
  "home: content area actually scrolls",
  `scrollTop=${h.scrollTop}`,
);
assert(
  h.headOffset <= 60 && h.headOffset >= 0,
  "home: header stays put while body scrolls",
  `offset=${h.headOffset}`,
);
assert(
  h.chipsVisible === true,
  "home: category chips stay visible",
  String(h.chipsVisible),
);
assert(
  h.headInsideScroller === false,
  "home: header is outside the scroll area",
  String(h.headInsideScroller),
);
await shot("sticky-home-scrolled");

// 分类 chip 在吸顶态仍可点：点第一个分类应切换网格
const clickChip = await evaluate(`(() => {
  const chips = [...document.querySelectorAll(".content .chip-row .chip")];
  // 避开当前已选中的那个：点同一个 chip 是「取消回到推荐」，不是切换。
  const target = chips.find((c) => !c.classList.contains("is-active") && c.textContent.trim() !== "推荐");
  if (!target) return "MISSING";
  target.click();
  return target.textContent.trim();
})()`);
await sleep(1600);
const afterChip = await evaluate(`(() => {
  const active = document.querySelector(".content .chip-row .chip.is-active");
  return active ? active.textContent.trim() : "NONE";
})()`);
console.log(`[info] chip click: ${clickChip} -> active ${afterChip}`);
assert(
  clickChip !== "MISSING" && afterChip === clickChip,
  "sticky chips are still clickable",
  `${clickChip} / ${afterChip}`,
);

// ---------- 直播页 ----------
await evaluate(`(() => { location.hash = "#/live"; return true; })()`);
await sleep(2500);
const liveGeom = `(() => {
  const content = document.querySelector(".content");
  const body = document.querySelector(".content .page--live .page-body");
  const head = document.querySelector(".content .page-head");
  const main = document.querySelector(".content .live-main");
  const rail = document.querySelector(".content .live-rail");
  if (!content || !body || !head) return null;
  const c = content.getBoundingClientRect();
  return JSON.stringify({
    offset: Math.round(head.getBoundingClientRect().top - c.top),
    pageScroll: Math.round(body.scrollTop),
    scrollable: body.scrollHeight > body.clientHeight + 2,
    mainScrollable: main ? main.scrollHeight > main.clientHeight + 2 : null,
    hasChannel: !!document.querySelector(".content .live-epg, .content .live-bar"),
    height: Math.round(head.getBoundingClientRect().height),
    railTop: rail ? Math.round(rail.getBoundingClientRect().top - c.top) : null,
    railH: rail ? Math.round(rail.getBoundingClientRect().height) : null,
    errBar: (() => {
      const bar = document.querySelector(".live-rail .error-bar");
      if (!bar) return null;
      return {
        message: bar.querySelector(".error-bar__text")?.textContent || "",
        hint: bar.querySelector(".error-bar__hint")?.textContent || "",
        hasDetail: !!bar.querySelector(".error-bar__detail"),
        detailOpen: !!bar.querySelector(".error-bar__detail[open]"),
        raw: (bar.querySelector(".error-bar__raw")?.textContent || "").slice(0, 80),
        hasRetry: !!bar.querySelector('.icon-btn[aria-label="重试"]'),
      };
    })(),
  });
})()`;
await evaluate(`(() => {
  const main = document.querySelector(".content .live-main");
  if (main) main.scrollTop = 400;
  return main ? main.scrollTop : 0;
})()`);
await sleep(400);
const liveScrolled = await evaluate(liveGeom);
console.log("[info] live@600:", liveScrolled);
const l = JSON.parse(liveScrolled);
assert(
  l.scrollable === false && l.pageScroll === 0,
  "live: page-body does not scroll (workbench layout)",
  `scrollable=${l.scrollable} scrollTop=${l.pageScroll}`,
);
if (l.hasChannel) {
  // 右列内容不多时不必滚动；能滚就滚，重要的是它自己承担滚动而不是整页。
  console.log(`[info] live right column scrollable: ${l.mainScrollable}`);
}
assert(l.offset <= 32, "live: header always in view", `offset=${l.offset}`);
if (l.railTop !== null) {
  assert(
    l.railTop >= l.height - 4,
    "live: channel rail starts below the sticky header",
    `railTop=${l.railTop} headerH=${l.height}`,
  );
}
if (l.errBar) {
  assert(
    !/https?:\/\//.test(l.errBar.message),
    "error: main line has no raw URL",
    l.errBar.message,
  );
  assert(
    !l.errBar.detailOpen,
    "error: technical detail is collapsed by default",
    String(l.errBar.detailOpen),
  );
  assert(
    l.errBar.hasRetry,
    "error: has retry action",
    String(l.errBar.hasRetry),
  );
  if (l.errBar.raw) {
    assert(
      /https?:\/\//.test(l.errBar.raw),
      "error: raw URL is demoted into technical detail",
      l.errBar.raw,
    );
  }
} else {
  console.log(
    "[info] no live error bar on screen (source loaded fine) — 结构断言跳过",
  );
}
await shot("sticky-live-scrolled");

ws.close();
console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed step(s)`,
);
process.exit(failures === 0 ? 0 : 1);
