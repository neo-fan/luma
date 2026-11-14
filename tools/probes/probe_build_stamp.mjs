#!/usr/bin/env node
/**
 * 快速验收：侧栏 build 时间戳格式 + 设置页「前端/后端构建」两行。
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
  return el ? { text: el.innerText.replace(/\\n/g, ' | '), title: el.querySelector('.sidebar__stamp')?.title || '' } : null;
})()`);
console.log("[sidebar]", JSON.stringify(foot));

// 进设置页看构建两行
await cdp.eval(`(() => {
  const btn = [...document.querySelectorAll('.nav__item')].find((n) => (n.textContent || '').includes('设置'));
  if (btn) btn.click();
  return !!btn;
})()`);
const builds = await cdp.eval(`(async () => {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const rows = [...document.querySelectorAll('.settings-kv > span')];
    if (rows.some((r) => r.textContent.includes('前端构建'))) {
      return rows.filter((r) => /构建/.test(r.textContent)).map((r) => {
        const code = r.nextElementSibling;
        return { label: r.textContent, value: code?.textContent || '', title: code?.title || '' };
      });
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return 'TIMEOUT';
})()`);
console.log("[settings]", JSON.stringify(builds, null, 2));
await cdp.shot("build-stamp");
cdp.ws.close();
