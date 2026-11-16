/**
 * S6 SiteSelect → Radix Select 验收：
 * 1. 首页开菜单：量测菜单边界在视口内（贴窗口左缘不被裁）
 * 2. 程序化点 data-key 项可选中（探针路径）
 * 3. 键盘 ↑↓ 可移动 data-highlighted（Radix 免费能力）
 */
import { writeFileSync } from "node:fs";

const CDP = "http://127.0.0.1:9222/json/list";
const list = await (await fetch(CDP)).json();
const page = list.find((t) => {
  try {
    const u = new URL(t.url);
    return t.type === "page" && u.port === "1420" && u.pathname === "/";
  } catch {
    return false;
  }
});
if (!page) throw new Error("no app target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
});
const cmd = (method, params = {}) => {
  const id = ++seq;
  return new Promise((res, rej) => {
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rej(new Error("timeout " + method));
      }
    }, 10000);
  });
};
const ev = async (ex) => {
  const r = await cmd("Runtime.evaluate", {
    expression: ex,
    awaitPromise: true,
    returnByValue: true,
  });
  return r?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
};

await cmd("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});

// 1. 打开菜单并量测
await ev(`document.querySelector(".app-select--site .app-select__trigger")?.click()`);
await sleep(600);
const geo = await ev(`(() => {
  const menu = document.querySelector(".app-select__menu");
  if (!menu) return { open: false };
  const r = menu.getBoundingClientRect();
  const first = menu.querySelector(".app-select__item .app-select__name")?.textContent;
  return {
    open: true,
    left: Math.round(r.left), right: Math.round(r.right),
    width: Math.round(r.width), items: menu.querySelectorAll(".app-select__item").length,
    first,
    inViewport: r.left >= 0 && r.right <= window.innerWidth,
  };
})()`);
ok("菜单打开且完整在视口内（贴左缘不被裁）", geo?.open && geo.inViewport,
  `left=${geo?.left} right=${geo?.right} width=${geo?.width} items=${geo?.items} first="${geo?.first}"`);

// 2. 程序化点 data-key 项（探针路径）
const picked = await ev(`(() => {
  const item = document.querySelector(".app-select__item[data-value]");
  if (!item) return null;
  const key = item.getAttribute("data-key");
  item.click();
  return key;
})()`);
await sleep(1200);
const after = await ev(`document.querySelector(".app-select--site")?.getAttribute("data-value")`);
ok("程序化 click 选中生效（探针契约）", !!picked && after === picked, `picked=${picked} data-value=${after}`);

// 3. 键盘导航（Radix 高亮）
await ev(`document.querySelector(".app-select--site .app-select__trigger")?.click()`);
await sleep(400);
await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
await sleep(300);
const hl = await ev(`document.querySelector(".app-select__item[data-highlighted]")?.textContent?.trim() || null`);
ok("键盘 ↓ 移动 Radix 高亮", !!hl, `highlighted="${hl}"`);
// 收起
await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

// 截图（菜单开着的样子）
await ev(`document.querySelector(".app-select--site .app-select__trigger")?.click()`);
await sleep(500);
const shot = await cmd("Page.captureScreenshot", { format: "png" });
if (shot?.data) {
  writeFileSync("tools/.out/ui-audit/radix-sitesel.png", Buffer.from(shot.data, "base64"));
  console.log("shot saved");
}
await cmd("Emulation.clearDeviceMetricsOverride");
process.exit(results.some((r) => !r.pass) ? 1 : 0);
