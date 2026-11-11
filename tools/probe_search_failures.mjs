#!/usr/bin/env node
/**
 * 搜索失败源回归：聚合失败不再只有一个数字，而是逐站可见、可单站重试。
 *
 * 1. 导入含「健康 py 源 + 必失败 py 源」的桩配置（/config-py.json）；
 * 2. 搜索页跑一次全站聚合，等待失败面板出现；
 * 3. 展开面板：断言失败站点名与原因都渲染出来（不是只有个数）；
 * 4. 点该行的「重试」，从日志文件确认真的发起了单站重试
 *    （窗口内调用太快，按钮文案来不及抓，日志是唯一可靠证据）；
 * 5. 失败源仍然留在列表里（不会被静默吞掉），最后恢复原配置。
 *
 * 依赖：dev 窗口（CDP 9222）+ python tests/stub_server.py。
 *   node tools/probe_search_failures.mjs
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Runtime.exceptionThrown") {
        const detail = msg.params?.exceptionDetails;
        this.errors.push(detail?.exception?.description || detail?.text || "unknown exception");
        return;
      }
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
      const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 120000);
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

  close() {
    this.ws.close();
  }
}

async function waitForPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
      const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      const page =
        pages.find((t) => t.url.startsWith("http://localhost:1420")) ??
        pages.find((t) => !t.url.startsWith("edge://") && !t.url.startsWith("chrome://"));
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("CDP page target not found");
}

const WAIT = (expression, timeout = 15000) => `(async () => {
  const deadline = Date.now() + ${timeout};
  while (Date.now() < deadline) {
    const value = (() => { ${expression} })();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
})()`;

const TYPE = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'MISSING';
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'TYPED';
})()`;

const CLICK = (label, selector = "button") => `(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const text = (el) => (el.textContent || '').trim();
  const target = nodes.find((el) => text(el) === ${JSON.stringify(label)})
    || nodes.find((el) => text(el).includes(${JSON.stringify(label)}));
  if (!target) return 'MISSING';
  target.click();
  return 'CLICKED';
})()`;

const ROWS = `(() => {
  const items = [...document.querySelectorAll('.failure-item')].map((el) => ({
    name: el.querySelector('.failure-item__name')?.innerText.trim() || '',
    reason: el.querySelector('.failure-item__reason')?.innerText.trim() || '',
    buttons: [...el.querySelectorAll('button')].map((b) => b.textContent.trim()),
  }));
  return JSON.stringify(items);
})()`;

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** logging.rs 用 UTC 日切，文件名按 UTC 日期算。 */
function todayLogFile() {
  const now = new Date();
  const utc = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate(),
  ).padStart(2, "0")}`;
  return path.join(os.homedir(), "AppData", "Roaming", "Luma", "logs", `luma-${utc}.log`);
}

function readLog(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

// 带 query 的地址：桩服务按 path 路由，而配置 id 由完整 origin 哈希——这样探针
// 不会覆盖/误删已有的 /config-py.json（曾经把别的探针留下的配置删掉过）。
const CONFIG = "http://127.0.0.1:8787/config-py.json?probe=search-failures";
const PROBE_NAME = "失败源探针配置";
const BROKEN_SITE = "Stub Python Broken";

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
console.log(`target: ${page.url}`);

let previousActive = "";
try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1200);
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000))) === "OK",
    "app rendered",
  );

  previousActive = await cdp.eval(
    `window.__TAURI_INTERNALS__.invoke('config_active').then((s) => (s ? s.id : ''))`,
  );
  console.log(`[info] previous active: ${previousActive}`);

  const imported = await cdp.eval(`(async () => {
    try {
      const snap = await window.__TAURI_INTERNALS__.invoke('config_import', {
        source: { kind: 'url', value: ${JSON.stringify(CONFIG)}, name: ${JSON.stringify(PROBE_NAME)} },
      });
      return JSON.stringify({ id: snap.id, enabled: snap.sites.filter((s) => s.enabled).length });
    } catch (err) {
      return 'ERR:' + JSON.stringify(err);
    }
  })()`);
  console.log(`[info] imported: ${imported}`);
  assert(typeof imported === "string" && imported.startsWith("{"), "probe config imported", String(imported));

  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000))) === "OK",
    "reloaded",
  );

  // 搜索页 → 全站聚合
  assert((await cdp.eval(CLICK("搜索", ".nav__item"))) === "CLICKED", "open search page");
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.search-bar input.input') ? 'OK' : null;", 15000))) === "OK",
    "search page rendered",
  );
  assert((await cdp.eval(TYPE(".search-bar input.input", "Stub"))) === "TYPED", "type keyword");
  // 侧栏「搜索」也是 button，必须限定表单里的提交按钮。
  assert((await cdp.eval(CLICK("搜索", ".search-bar button"))) === "CLICKED", "submit search");

  // 聚合墙钟 20s；失败面板在结果渲染后才出现。
  const panelText = await cdp.eval(
    WAIT("const el = document.querySelector('.failure-panel button'); return el ? el.innerText.trim() : null;", 60000),
  );
  console.log(`[info] failure toggle: ${panelText}`);
  assert(!!panelText && /查看\s*\d+\s*个失败源/.test(panelText), "failure toggle rendered", String(panelText));

  assert((await cdp.eval(CLICK("查看"))) === "CLICKED", "expand failure list");
  await cdp.eval(WAIT("return document.querySelector('.failure-item') ? 'OK' : null;", 10000));
  const rows = JSON.parse((await cdp.eval(ROWS)) || "[]");
  console.log(`[info] failure rows: ${JSON.stringify(rows)}`);
  const broken = rows.find((row) => row.name.includes(BROKEN_SITE));
  assert(!!broken, "failed site is listed by name", JSON.stringify(rows));
  assert((broken?.reason || "").length > 0, "failure reason is shown", String(broken?.reason));
  assert(
    (broken?.buttons || []).includes("重试"),
    "each failed site has a retry button",
    JSON.stringify(broken?.buttons),
  );

  // 单站重试：本地失败太快，抓不住「重试中…」，改从日志确认请求真的发出去了。
  const logFile = todayLogFile();
  const before = readLog(logFile);
  assert((await cdp.eval(CLICK("重试", ".failure-item button"))) === "CLICKED", "click 重试");
  await sleep(2500);
  const after = readLog(logFile);
  assert(
    after.length > before.length && /search retry failed/.test(after),
    "retry request reached the backend (log)",
    logFile,
  );
  assert(/stub_py_broken/.test(after), "retry targeted the failed site", "stub_py_broken");

  const rowsAfter = JSON.parse((await cdp.eval(ROWS)) || "[]");
  console.log(`[info] failure rows after retry: ${JSON.stringify(rowsAfter)}`);
  assert(
    rowsAfter.some((row) => row.name.includes(BROKEN_SITE)),
    "still-broken site stays visible after retry",
    JSON.stringify(rowsAfter),
  );
} catch (err) {
  failures += 1;
  console.error(`[FAIL] probe crashed: ${err && err.message ? err.message : err}`);
  if (cdp.errors.length) {
    console.error(`[info] page errors: ${JSON.stringify(cdp.errors.slice(0, 3))}`);
  }
} finally {
  try {
    if (previousActive) {
      await cdp.eval(
        `window.__TAURI_INTERNALS__.invoke('config_activate', { id: ${JSON.stringify(previousActive)} }).then(() => 'OK').catch(() => 'ERR')`,
      );
    }
    const removed = await cdp.eval(`(async () => {
      const rows = await window.__TAURI_INTERNALS__.invoke('config_list');
      const probe = rows.find((r) => r.name === ${JSON.stringify(PROBE_NAME)});
      if (!probe) return 'NONE';
      await window.__TAURI_INTERNALS__.invoke('config_remove', { id: probe.id });
      return 'OK';
    })().catch((e) => 'ERR:' + JSON.stringify(e))`);
    console.log(`[info] cleanup: ${removed}`);
  } catch (err) {
    console.error(`[warn] cleanup failed: ${err && err.message ? err.message : err}`);
  }
  cdp.close();
}

console.log(failures === 0 ? "\nPASS search failures" : `\nFAILED ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
