#!/usr/bin/env node
/**
 * 快速验收：侧栏 build 号与设置页「构建号」是同一个 14 位时间戳（宿主启动时刻）。
 * 用法：node tools/probes/probe_build_stamp.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";

const CDP = "http://127.0.0.1:9222/json/list";

function isApp(t) {
  if (t.type !== "page" || !t.webSocketDebuggerUrl) return false;
  try {
    const u = new URL(t.url);
    return u.port === "1420" && u.pathname === "/";
  } catch {
    return false;
  }
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener("open", res, { once: true });
      this.ws.addEventListener("error", rej, { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
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
      const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 30000);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
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
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
    return res.result?.value;
  }
  async shot(name) {
    const res = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 86 });
    mkdirSync("tools/.out/shots", { recursive: true });
    writeFileSync(`tools/.out/shots/${name}.jpg`, Buffer.from(res.data, "base64"));
    console.log(`[shot] tools/.out/shots/${name}.jpg`);
  }
}

const list = await (await fetch(CDP)).json();
const target = list.find(isApp);
if (!target) throw new Error("app target not found");
const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.send("Page.enable");

const foot = await cdp.eval(`(() => {
  const el = document.querySelector('.sidebar__foot');
  if (!el) return null;
  const stamp = el.querySelector('.sidebar__stamp');
  return {
    text: el.innerText.replace(/\\n/g, ' | '),
    build: (stamp?.innerText || '').replace(/^build:\\s*/, '').trim(),
    title: stamp?.title || '',
  };
})()`);
console.log("[sidebar]", JSON.stringify(foot));

// 进设置页看统一后的「构建号」一行
await cdp.eval(`(() => {
  const btn = [...document.querySelectorAll('.nav__item')].find((n) => (n.textContent || '').includes('设置'));
  if (btn) btn.click();
  return !!btn;
})()`);
const buildRow = await cdp.eval(`(async () => {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const rows = [...document.querySelectorAll('.settings-kv > span')];
    const label = rows.find((r) => r.textContent.includes('构建号'));
    if (label) {
      const code = label.nextElementSibling;
      return { label: label.textContent, value: code?.textContent || '', title: code?.title || '' };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return 'TIMEOUT';
})()`);
console.log("[settings]", JSON.stringify(buildRow, null, 2));

const staleLabels = await cdp.eval(
  `[...document.querySelectorAll('.settings-kv > span')].some((r) => /前端构建|后端构建/.test(r.textContent))`,
);
if (!foot) throw new Error("sidebar foot not found");
if (buildRow === "TIMEOUT") throw new Error("settings 构建号 row not found");
if (staleLabels) throw new Error("设置页仍有「前端构建 / 后端构建」两行，应合并为「构建号」");

const settingsBuild = (buildRow.value.match(/build:\s*([0-9]+)/) || [])[1] || "";
for (const [label, value] of [
  ["sidebar", foot.build],
  ["settings", settingsBuild],
]) {
  if (!/^\d{14}$/.test(value)) {
    throw new Error(`${label} build 号不是 14 位时间戳: ${JSON.stringify(value)}`);
  }
}
if (foot.build !== settingsBuild) {
  throw new Error(`前后端 build 号不一致: sidebar=${foot.build} settings=${settingsBuild}`);
}
console.log(`[ok] 前后端 build 号统一为 ${settingsBuild}（本次启动时刻）`);
await cdp.shot("build-stamp");
cdp.ws.close();
