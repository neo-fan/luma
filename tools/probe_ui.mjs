#!/usr/bin/env node
/**
 * T-10 / T-11 UI smoke: drive the real window through CDP and screenshot each
 * step. Requires the dev window with --remote-debugging-port=9222 and the stub
 * server on 127.0.0.1:8787.
 *
 * Exit 0 only when every step produced the expected text on screen.
 */

import { writeFileSync } from "node:fs";

const CDP = "http://127.0.0.1:9222/json/list";
const SHOT_DIR = ".workbuddy";

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
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
      const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 40000);
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

  async shot(name) {
    // png 会卡死（实测在本机 WebView2 上 Page.captureScreenshot 用 png 直接超时），
    // 全部改 jpeg，约 140ms 返回。
    const res = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 85 });
    const path = `${SHOT_DIR}/${name}.jpg`;
    writeFileSync(path, Buffer.from(res.data, "base64"));
    console.log(`[shot] ${path}`);
  }

  close() {
    this.ws.close();
  }
}

async function waitForPage(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(CDP);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* CDP not up yet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("CDP page target not found");
}

const CLICK = (label) => `(() => {
  const nodes = [...document.querySelectorAll('button, .nav__item, a')];
  const target = nodes.find((n) => (n.textContent || '').trim().includes(${JSON.stringify(label)}));
  if (!target) return 'MISSING';
  target.click();
  return 'CLICKED';
})()`;

const TYPE = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'MISSING';
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'TYPED';
})()`;

const TEXT = `document.body.innerText`;
const WAIT_TEXT = (needle, timeout = 20000) => `(async () => {
  const deadline = Date.now() + ${timeout};
  while (Date.now() < deadline) {
    if (document.body.innerText.includes(${JSON.stringify(needle)})) return 'FOUND';
    await new Promise((r) => setTimeout(r, 250));
  }
  return 'TIMEOUT';
})()`;

let failures = 0;
function assert(condition, label, detail = "") {
  if (condition) {
    console.log(`[ok  ] ${label}${detail ? `  -- ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`[FAIL] ${label}${detail ? `  -- ${detail}` : ""}`);
  }
}

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
console.log(`target: ${page.url}`);

// 1. shell renders。按结构判断而不是等某个品牌文案：产品改名后旧文案
// （"TVBox"）已不在页面上，用文案做就绪判断会把正常窗口误报成 TIMEOUT。
const shell = await cdp.eval(`(async () => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (document.querySelector('.nav__item') && document.querySelector('.content')) return 'FOUND';
    await new Promise(r => setTimeout(r, 250));
  }
  return 'TIMEOUT';
})()`);
assert(shell === "FOUND", "shell rendered", shell);

// 2. settings + config import through the real UI
await cdp.eval(CLICK("设置"));
assert((await cdp.eval(WAIT_TEXT("导入配置（URL）"))) === "FOUND", "settings page", "");
assert((await cdp.eval(TYPE('input.input', "http://127.0.0.1:8787/config.json"))) === "TYPED", "typed config url", "");
await cdp.eval(CLICK("导入"));
const imported = await cdp.eval(WAIT_TEXT("已导入", 30000));
assert(imported === "FOUND", "config imported", imported);
await cdp.shot("ui-1-settings");

// 3. home renders site content
await cdp.eval(CLICK("首页"));
const homeOk = await cdp.eval(WAIT_TEXT("Stub Home Movie", 30000));
assert(homeOk === "FOUND", "home aggregated list", homeOk);
await cdp.shot("ui-2-home");

// 4. detail page
await cdp.eval(`(() => {
  const card = [...document.querySelectorAll('.vod-card, button, a')]
    .find((n) => (n.textContent || '').includes('Stub Home Movie'));
  if (!card) return 'MISSING';
  card.click();
  return 'CLICKED';
})()`);
const detailOk = await cdp.eval(WAIT_TEXT("播放线路", 30000));
assert(detailOk === "FOUND", "detail page episodes", detailOk);
await cdp.shot("ui-3-detail");

// 5. favourite from the detail title row (sidebar also has a 收藏 entry)
// 收藏已改成剧名旁的单图标星（无文案），状态只能读 aria-pressed。
// idempotent: only toggle when the current state is "not favourited"
const favBtn = await cdp.eval(`(() => {
  const btn = document.querySelector('.detail-title-row .fav-star');
  if (!btn) return 'MISSING';
  if (btn.getAttribute('aria-pressed') === 'true') return 'ALREADY';
  btn.click();
  return 'CLICKED';
})()`);
assert(favBtn !== 'MISSING', "detail title has a favourite star", favBtn);
const favOk = await cdp.eval(`(async () => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const btn = document.querySelector('.detail-title-row .fav-star');
    if (btn && btn.getAttribute('aria-pressed') === 'true') return 'OK';
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
})()`);
assert(favOk === "OK", "favourite toggled", String(favOk));

// 6. player page
await cdp.eval(`(() => {
  const ep = [...document.querySelectorAll('button')]
    .find((n) => /第\\s*1\\s*集/.test(n.textContent || ''));
  if (!ep) return 'MISSING';
  ep.click();
  return 'CLICKED';
})()`);
const hasVideo = await cdp.eval(`(async () => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (document.querySelector('video')) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
})()`);
const playerText = await cdp.eval(TEXT);
assert(hasVideo === true, "player mounted video element", hasVideo ? "" : playerText.slice(0, 120));
await new Promise((r) => setTimeout(r, 2500));
await cdp.shot("ui-4-player");

// 7. search page
await cdp.eval(CLICK("搜索"));
const searchOk = await cdp.eval(WAIT_TEXT("搜索", 15000));
assert(searchOk === "FOUND", "search page", searchOk);
await cdp.shot("ui-5-search");

// 8. favourites page shows the saved entry
await cdp.eval(`(() => {
  const nav = [...document.querySelectorAll('.nav__item')].find((n) => (n.textContent || '').includes('收藏'));
  if (!nav) return 'MISSING';
  nav.click();
  return 'CLICKED';
})()`);
const favList = await cdp.eval(WAIT_TEXT("Stub", 20000));
assert(favList === "FOUND", "favourites list persisted", favList);
await cdp.shot("ui-6-favorites");

const errors = await cdp.eval(`(() => {
  const el = document.querySelector('.error-bar');
  return el ? el.innerText : '';
})()`);
assert(!errors, "no error banner", errors || "clean");

cdp.close();
console.log(failures === 0 ? "\nUI SMOKE OK" : `\nUI SMOKE FAIL: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
