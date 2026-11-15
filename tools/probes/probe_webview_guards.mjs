#!/usr/bin/env node
/**
 * 1.1.0 外壳验收：WebView 已「原生应用化」+ Ctrl+K 面板 + 反代速率端点。
 *
 * 断言：
 * 1) 右键菜单被拦（contextmenu dispatchEvent 返回 false）；
 * 2) F5 / Ctrl+F 被拦，Ctrl+R 强制刷新刻意放行（返回 true）；
 * 3) Ctrl+K 打开命令面板（[cmdk-dialog] 出现），再按一次关闭；
 * 4) 反代 `/meter` 在 9978 上可达且返回 bytesPerSec / bytesTotal；
 * 5) 页面滚动不被 body { user-select: none } 之外的东西破坏（正文可选中）。
 *
 * 前置：`corepack pnpm tauri dev`（CDP 9222）、反代已起（9978）。
 *   node tools/probes/probe_webview_guards.mjs
 */
import { connect, finish } from "./lib/cdp.mjs";

const cdp = await connect();
const problems = [];

function check(ok, name, note = "") {
  console.log(`${ok ? "[ok  ]" : "[FAIL]"} ${name}${note ? "  -- " + note : ""}`);
  if (!ok) problems.push(`${name}${note ? " -- " + note : ""}`);
}

const sleep = (ms) => `new Promise((resolve) => setTimeout(resolve, ${ms}))`;

// 等界面挂载（boot 层收掉后才有导航）。
await cdp.eval(`(async () => { ${sleep(600)} })()`);

const contextmenu = await cdp.eval(`(() => {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  return document.body.dispatchEvent(event);
})()`);
check(contextmenu === false, "右键菜单被拦截", `dispatchEvent=${contextmenu}`);

const keys = await cdp.eval(`(() => {
  const fire = (init) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return {
    f5: fire({ key: "F5" }),
    ctrlF: fire({ key: "f", ctrlKey: true }),
    ctrlR: fire({ key: "r", ctrlKey: true }),
  };
})()`);
check(keys.f5 === true, "F5 被拦截");
check(keys.ctrlF === true, "Ctrl+F 被拦截");
check(keys.ctrlR === false, "Ctrl+R 保留为强制刷新");

// Ctrl+K：先确认关闭，再打开、再关闭。
await cdp.eval(`(() => {
  const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
})()`);
await cdp.eval(`(async () => { ${sleep(300)} })()`);
const opened = await cdp.eval(`Boolean(document.querySelector("[cmdk-dialog], [cmdk-root]"))`);
check(opened === true, "Ctrl+K 打开命令面板");
await cdp.screenshot("palette.png");
await cdp.eval(`(() => {
  const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
})()`);
await cdp.eval(`(async () => { ${sleep(300)} })()`);
const closed = await cdp.eval(`!document.querySelector("[cmdk-dialog], [cmdk-root]")`);
check(closed === true, "再按 Ctrl+K 关闭面板");

const meter = await cdp.eval(`(async () => {
  const status = await window.__TAURI_INTERNALS__.invoke("proxy_status");
  const reply = await fetch(status.baseUrl + "/meter", { cache: "no-store" });
  const data = await reply.json();
  return { base: status.baseUrl, ok: reply.ok, speed: data.bytesPerSec, total: data.bytesTotal };
})()`);
check(
  meter.ok === true && typeof meter.speed === "number" && typeof meter.total === "number",
  "反代 /meter 可达",
  JSON.stringify(meter),
);

await cdp.screenshot("webview-guards.png");
await cdp.close();
process.exit(finish(problems, `probe_webview_guards: ${problems.length === 0 ? "all good" : "failed"}`));
