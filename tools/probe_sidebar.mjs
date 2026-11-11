#!/usr/bin/env node
/**
 * 侧边栏收缩 / 展开回归：
 *   1. 默认展开：宽度 ~204，5 个图标 + 5 个文字标签可见；
 *   2. 点「收起」→ `.is-collapsed`，宽度 ~68，图标仍可见、文字隐藏；
 *   3. 收缩态下点「搜索」仍能切换页面；
 *   4. 再点展开 → 宽度恢复、文字恢复；
 *   5. 收缩后 reload，偏好从 localStorage 恢复。
 *
 * 依赖 dev 窗口（CDP 9222）。  node tools/probe_sidebar.mjs
 */
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

const SNAPSHOT = `(() => {
  const bar = document.querySelector('.sidebar');
  if (!bar) return null;
  const icons = [...bar.querySelectorAll('.nav__item .nav__icon')];
  const labels = [...bar.querySelectorAll('.nav__label')];
  const visible = (el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
  return JSON.stringify({
    collapsed: bar.classList.contains('is-collapsed'),
    width: Math.round(bar.getBoundingClientRect().width),
    icons: icons.length,
    visibleIcons: icons.filter(visible).length,
    collapseIconVisible: (() => {
      const el = bar.querySelector('.sidebar__collapse .nav__icon');
      return !!el && visible(el);
    })(),
    labels: labels.length,
    visibleLabels: labels.filter(visible).length,
    brandTextVisible: (() => { const el = bar.querySelector('.brand__text'); return !!el && visible(el); })(),
    footVisible: (() => { const el = bar.querySelector('.sidebar__foot'); return !!el && visible(el); })(),
    stored: localStorage.getItem('luma:sidebar:v1'),
  });
})()`;

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
console.log(`target: ${page.url}`);

try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  // 从展开态开始：清掉上次探针写入的偏好。
  await cdp.eval(`localStorage.removeItem('luma:sidebar:v1')`);
  await cdp.send("Page.reload", { ignoreCache: true });

  assert(
    (await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000))) === "OK",
    "sidebar rendered",
  );

  const expanded = JSON.parse((await cdp.eval(SNAPSHOT)) || "null");
  console.log(`[info] expanded: ${JSON.stringify(expanded)}`);
  assert(expanded?.collapsed === false, "starts expanded", JSON.stringify(expanded));
  assert(expanded?.width >= 180, "expanded width ~204", String(expanded?.width));
  assert(expanded?.icons === 5 && expanded?.visibleIcons === 5, "5 nav icons visible", JSON.stringify(expanded));
  assert(expanded?.visibleLabels === 6, "labels visible (5 nav + 收起)", JSON.stringify(expanded));
  assert(expanded?.brandTextVisible === true && expanded?.footVisible === true, "brand/foot visible", JSON.stringify(expanded));

  const collapse = await cdp.eval(`(() => {
    const btn = document.querySelector('.sidebar__collapse');
    if (!btn) return 'MISSING';
    btn.click();
    return 'CLICKED';
  })()`);
  assert(collapse === "CLICKED", "click 收起", collapse);
  await cdp.eval(WAIT("return document.querySelector('.sidebar.is-collapsed') ? 'OK' : null;", 5000));
  // 宽度过渡 180ms，等动画结束再读像素尺寸。
  await sleep(350);
  const collapsed = JSON.parse((await cdp.eval(SNAPSHOT)) || "null");
  console.log(`[info] collapsed: ${JSON.stringify(collapsed)}`);
  assert(collapsed?.collapsed === true, "sidebar collapsed", JSON.stringify(collapsed));
  assert(collapsed?.width <= 80, "collapsed width ~68", String(collapsed?.width));
  assert(collapsed?.visibleIcons === 5, "icons still visible when collapsed", JSON.stringify(collapsed));
  assert(collapsed?.visibleLabels === 0, "labels hidden when collapsed", JSON.stringify(collapsed));
  assert(collapsed?.brandTextVisible === false && collapsed?.footVisible === false, "brand/foot hidden", JSON.stringify(collapsed));
  assert(collapsed?.stored === "1", "collapse persisted", String(collapsed?.stored));

  // 收缩态下仍可导航：点「搜索」（靠 aria-label，不依赖可见文字）。
  const nav = await cdp.eval(`(() => {
    const item = [...document.querySelectorAll('.nav__item')].find((n) => n.getAttribute('aria-label') === '搜索');
    if (!item) return 'MISSING';
    item.click();
    return 'CLICKED';
  })()`);
  assert(nav === "CLICKED", "click 搜索 while collapsed", nav);
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.search-bar input.input') ? 'OK' : null;", 15000))) === "OK",
    "navigation still works when collapsed",
  );

  const expand = await cdp.eval(`(() => {
    const btn = document.querySelector('.sidebar__collapse');
    if (!btn) return 'MISSING';
    btn.click();
    return 'CLICKED';
  })()`);
  assert(expand === "CLICKED", "click 展开", expand);
  await cdp.eval(WAIT("return !document.querySelector('.sidebar.is-collapsed') ? 'OK' : null;", 5000));
  await sleep(350);
  const restored = JSON.parse((await cdp.eval(SNAPSHOT)) || "null");
  console.log(`[info] restored: ${JSON.stringify(restored)}`);
  assert(restored?.width >= 180, "width restored", String(restored?.width));
  assert(restored?.visibleLabels === 6, "labels restored", JSON.stringify(restored));
  assert(restored?.stored === "0", "expand persisted", String(restored?.stored));

  // 收缩后 reload：偏好应恢复为收缩态。
  await cdp.eval(`(() => { const b = document.querySelector('.sidebar__collapse'); b && b.click(); return true; })()`);
  await cdp.eval(WAIT("return document.querySelector('.sidebar.is-collapsed') ? 'OK' : null;", 5000));
  await sleep(250); // 等 React effect 把偏好写进 localStorage
  await cdp.send("Page.reload", { ignoreCache: true });
  // reload 是异步的：先给页面重建时间，再等侧栏渲染，避免读到旧上下文。
  await sleep(1500);
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000))) === "OK",
    "reloaded",
  );
  await sleep(300);
  const afterReload = JSON.parse((await cdp.eval(SNAPSHOT)) || "null");
  console.log(`[info] after reload: ${JSON.stringify(afterReload)}`);
  assert(afterReload?.collapsed === true, "collapse persisted across reload", JSON.stringify(afterReload));

  // 恢复展开，避免影响后续探针（它们按文字点侧栏，虽然 textContent 仍可用）。
  await cdp.eval(`(() => { const b = document.querySelector('.sidebar__collapse'); b && b.click(); return true; })()`);
} catch (err) {
  console.log(`[diag] unexpected error: ${String((err && err.stack) || err)}`);
  failures += 1;
}

assert(
  cdp.errors.length === 0,
  "no uncaught page exceptions",
  cdp.errors.slice(0, 3).join(" | ").slice(0, 600),
);
cdp.close();
console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed step(s)`);
process.exit(failures === 0 ? 0 : 1);
