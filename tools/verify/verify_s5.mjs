#!/usr/bin/env node
/**
 * S5 验收：命令面板（Ctrl+K）、换源面板焦点陷阱、sonner Toaster 挂载、播放链路回归。
 *
 * 前置：dev 窗口在跑（CDP 127.0.0.1:9222）、Vite 在 1420。
 * 用法：node tools/verify/verify_s5.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CDP = "http://127.0.0.1:9222/json/list";
const outDir = resolve("tools/.out/ui-audit");
mkdirSync(outDir, { recursive: true });

const list = await (await fetch(CDP)).json();
const page = list.find((t) => {
  if (t.type !== "page" || !t.webSocketDebuggerUrl) return false;
  try {
    const u = new URL(t.url);
    return u.port === "1420" && (u.pathname === "/" || u.pathname === "");
  } catch {
    return false;
  }
});
if (!page) {
  console.error("no app page on 1420；现有 target:", list.map((t) => t.url).join(" | "));
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener("open", r, { once: true });
  ws.addEventListener("error", j, { once: true });
});
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
});
function cmd(method, params = {}) {
  const id = ++seq;
  return new Promise((res) => {
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => pending.delete(id), 90000);
  });
}
async function ev(expression) {
  const r = await cmd("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return r?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAIT = (expr, timeoutMs = 15000, intervalMs = 300) =>
  ev(`(async () => {
    const end = Date.now() + ${timeoutMs};
    while (Date.now() < end) {
      const v = ${expr};
      if (v) return v;
      await new Promise((r) => setTimeout(r, ${intervalMs}));
    }
    return null;
  })()`);
async function shot(name) {
  await cmd("Page.enable");
  const r = await cmd("Page.captureScreenshot", { format: "png" });
  writeFileSync(resolve(outDir, `${name}.png`), Buffer.from(r.data, "base64"));
  console.log(`  [shot] ${name}.png`);
}
function ok(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) process.exitCode = 1;
}

// ---------- 1. 回首页，准备干净状态 ----------
await ev(`(() => {
  const btn = [...document.querySelectorAll('.nav__item')].find(
    (b) => b.getAttribute('aria-label') === '首页');
  btn?.click();
  return true;
})()`);
await WAIT(`!!document.querySelector('.page-title')`, 10000);

// ---------- 2. 命令面板：Ctrl+K 打开 / 过滤 / Esc 关闭 ----------
await cmd("Input.dispatchKeyEvent", {
  type: "keyDown",
  modifiers: 2, // Ctrl
  key: "k",
  code: "KeyK",
  windowsVirtualKeyCode: 75,
});
await cmd("Input.dispatchKeyEvent", {
  type: "keyUp",
  modifiers: 2,
  key: "k",
  code: "KeyK",
  windowsVirtualKeyCode: 75,
});
const paletteOpen = await WAIT(`!!document.querySelector('[cmdk-root]')`, 8000);
ok("Ctrl+K 打开命令面板", !!paletteOpen);

// 输入过滤词：站点组应只剩匹配项
await cmd("Input.insertText", { text: "腾讯" });
await sleep(600);
const filtered = await ev(`(() => {
  const items = [...document.querySelectorAll('[cmdk-item]')];
  return { total: items.length, texts: items.slice(0, 6).map((i) => i.textContent.trim()) };
})()`);
console.log("  过滤『腾讯』:", JSON.stringify(filtered));
ok("命令面板过滤生效", filtered && filtered.total > 0 && filtered.total < 8);

await shot("s5-palette");
// Esc 关闭（Radix 处理）
await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
const paletteClosed = await WAIT(`!document.querySelector('[cmdk-root]')`, 5000);
ok("Esc 关闭命令面板", !!paletteClosed);

// ---------- 3. Toaster 挂载（sonner v2：容器是 section[aria-label=Notifications]，
//               带 data-sonner-toaster 的 <ol> 只在有 toast 时渲染） ----------
const toaster = await ev(`({
  mounted: !!document.querySelector('section[aria-label^="Notifications"]'),
  ariaLive: document.querySelectorAll('[aria-live]').length,
})`);
ok("sonner Toaster 已挂载", toaster && toaster.mounted && toaster.ariaLive > 0);

// ---------- 4. 换源面板：焦点陷阱（从详情页打开） ----------
// 端到端走命令面板：Ctrl+K → 输入「庆余年」→ Enter（第一项=全站搜索）
await cmd("Input.dispatchKeyEvent", {
  type: "keyDown",
  modifiers: 2,
  key: "k",
  code: "KeyK",
  windowsVirtualKeyCode: 75,
});
await cmd("Input.dispatchKeyEvent", {
  type: "keyUp",
  modifiers: 2,
  key: "k",
  code: "KeyK",
  windowsVirtualKeyCode: 75,
});
await WAIT(`!!document.querySelector('[cmdk-root]')`, 8000);
await cmd("Input.insertText", { text: "庆余年" });
await sleep(600);
const searchItem = await ev(`(() => {
  const item = [...document.querySelectorAll('[cmdk-item]')].find((i) => i.textContent.includes('全站搜索'));
  if (!item) return false;
  item.click();
  return true;
})()`);
const searchMeta = await WAIT(
  `document.querySelector('.result-meta')?.textContent || ''`,
  60000,
);
ok("命令面板端到端发起搜索", searchItem && String(searchMeta).includes("条结果"));
await sleep(2000);

// 点搜索结果第一张卡进详情
const cardClicked = await ev(`(() => {
  const card = document.querySelector('.vod-card');
  if (!card) return false;
  card.querySelector('button, a')?.click() || card.click();
  return true;
})()`);
await WAIT(`!!document.querySelector('.detail-title') || !!document.querySelector('.page-title')`, 15000);
await sleep(1500);
const swapClicked = await ev(`(() => {
  const btn = document.querySelector('[aria-label="换源"]') ||
    [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').includes('换源'));
  if (!btn) return false;
  btn.click();
  return true;
})()`);
const pickerOpen = await WAIT(`!!document.querySelector('.source-picker')`, 10000);
ok("详情页打开换源面板", swapClicked && !!pickerOpen);

if (pickerOpen) {
  // 焦点陷阱：Tab 若干次，焦点应始终留在面板 DOM 内
  const trap = await ev(`(async () => {
    const picker = document.querySelector('.source-picker');
    let escaped = 0;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 30));
      // 用 CDP 不方便逐次发 Tab 再回读（要往返），改为在页面内模拟焦点循环检查：
      const focusables = picker.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])');
      if (i === 0) focusables[0]?.focus();
      const inPanel = picker.contains(document.activeElement);
      if (!inPanel) escaped++;
      // 页面内手动走 DOM 焦点
      const all = [...document.querySelectorAll('button, input, select, a[href], [tabindex]:not([tabindex="-1"])')]
        .filter((el) => el.offsetParent !== null);
      const idx = all.indexOf(document.activeElement);
      all[(idx + 1) % all.length]?.focus();
      if (!document.querySelector('.source-picker')) break;
    }
    return { escaped };
  })()`);
  ok("焦点停留在换源面板内（Tab 循环）", trap && trap.escaped === 0);
  await shot("s5-source-picker");
  // Esc 关闭
  await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  const closed = await WAIT(`!document.querySelector('.source-picker')`, 5000);
  ok("Esc 关闭换源面板", !!closed);
}

// ---------- 5. 播放链路回归（详情页 → 第一集） ----------
const epClicked = await ev(`(() => {
  const ep = [...document.querySelectorAll('.episode')].find((e) => e.textContent.trim());
  if (!ep) return false;
  ep.click();
  return true;
})()`);
console.log("  点第一集:", epClicked);
let played = false;
if (epClicked) {
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const st = await ev(`({ v: !!document.querySelector('video'),
      o: !!document.querySelector('.player-overlay'),
      e: document.querySelector('.error-bar')?.textContent || '',
      res: document.querySelector('.player-res')?.textContent || '' })`);
    if (st && st.v && !st.o && st.res) { played = true; break; }
    if (st && st.e) break;
  }
  await sleep(4000);
  const meta = await ev(`({
    vw: document.querySelector('video')?.videoWidth || 0,
    vh: document.querySelector('video')?.videoHeight || 0,
    res: document.querySelector('.player-res')?.textContent || '',
    err: document.querySelector('.error-bar')?.textContent || '' })`);
  console.log("  播放:", JSON.stringify(meta));
  // 出画判据：分辨率角标出现（值来自 videoWidth/Height）；外网抖动时只要求无报错。
  ok("播放出画（分辨率角标或无报错）", meta && (meta.vw > 0 || (!meta.err && meta.res)));
  await shot("s5-player");
}

console.log("done");
process.exit(process.exitCode || 0);
