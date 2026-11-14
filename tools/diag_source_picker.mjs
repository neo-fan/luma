#!/usr/bin/env node
/**
 * 手动换源面板走查：量测每个控件的实际盒模型，找出尺寸不齐的地方。
 * 用法：node tools/diag_source_picker.mjs [--shot]
 */
import { writeFileSync, mkdirSync } from "node:fs";

const SHOT = process.argv.includes("--shot");
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
    const timer = setTimeout(() => rej(new Error(`${method} timeout`)), 120000);
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
await send("Runtime.enable");
await send("Page.enable");

// 固定视口，量测才有可比性
await send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});

const hash = await evaluate("location.hash");
console.log("hash:", hash);

// 从首页点进详情
await evaluate("location.hash = '#/'");
await sleep(1500);
const opened = await evaluate(`(() => {
  const card = document.querySelector('.vod-card a, .vod-card');
  if (!card) return 'no-card';
  (card.closest('a') || card).click();
  return 'ok';
})()`);
console.log("open detail:", opened);
await sleep(2500);

const trigger = await evaluate(`(() => {
  const btn = document.querySelector('[aria-label="换源"]');
  if (!btn) return 'no-swap';
  btn.click();
  return 'ok';
})()`);
console.log("open picker:", trigger);
await sleep(1200);

// 等候选出现（后台预取可能还在跑），最多 35s
for (let i = 0; i < 70; i += 1) {
  const n = await evaluate("document.querySelectorAll('.source-item').length");
  if (n > 0) {
    console.log("items:", n, `after ${(i * 500) / 1000}s`);
    break;
  }
  await sleep(500);
}
await sleep(600);

const report = await evaluate(`(() => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ').filter(Boolean).join('.'),
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
      pad: cs.padding, font: cs.fontSize + '/' + cs.fontWeight,
      radius: cs.borderRadius,
      border: cs.borderWidth + ' ' + cs.borderColor,
      display: cs.display,
    };
  };
  const root = document.querySelector('.source-picker');
  if (!root) return { error: 'no picker' };
  const search = root.querySelector('.source-picker__search');
  const items = [...root.querySelectorAll('.source-item')];
  return {
    picker: box(root),
    head: box(root.querySelector('.source-picker__head')),
    search: box(search),
    searchKids: [...search.children].map(box),
    meta: box(root.querySelector('.source-picker__meta')),
    metaKids: [...(root.querySelector('.source-picker__meta')?.children || [])].map(box),
    list: box(root.querySelector('.source-picker__list')),
    items: items.map(box),
    itemMains: items.map((i) => box(i.querySelector('.source-item__main'))),
    itemButtons: items.map((i) => box(i.querySelector('button'))),
    foot: box(root.querySelector('.source-picker__foot')),
    itemTexts: items.map((i) => i.innerText.replace(/\\n/g, ' | ')),
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
  };
})()`);
console.log(JSON.stringify(report, null, 2));

if (SHOT) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(300);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const file = `${OUT}/source-picker.png`;
  writeFileSync(file, Buffer.from(shot.result.data, "base64"));
  console.log("shot:", file);
}
ws.close();
