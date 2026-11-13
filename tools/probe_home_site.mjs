#!/usr/bin/env node
/**
 * 首页站点记忆 + 默认空站自动顺延回归。
 *
 * 覆盖三件事（只读 + 只动 localStorage，不改后端配置、不导入配置）：
 *   1. 手动切站后 reload 仍停在该站（记住用户切换的首页）且有卡片；
 *   2. 清掉偏好模拟冷启动：默认站自带内容则直接出卡（无需顺延）、真空则自动
 *      顺延到有内容的站并记住。2026-11-11 py 框架对齐修复后豆瓣 frodo 返回
 *      20 条，默认站不再是空站，故两种现实都接受，不硬编码「豆瓣必空」；
 *   3. 用户手动选站后 reload 不被自动跳走（尊重用户选择，永久关闭顺延）。
 *
 * 前置：dev 窗口在跑（CDP 9222）、active 配置含至少一个首页有 list 的站
 * （真实 box 配置的「直播[py]」有 63 条）。不依赖外网：探测走 dev 已加载的
 * 站点缓存，homeContent 由后端 + 桩/真实源解析，慢站有超时兜底。
 */
const HOME_SITE_KEY = "luma:home:site:v1";
const CDP = "http://127.0.0.1:9222/json/list";

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
        const d = msg.params?.exceptionDetails;
        this.errors.push(d?.exception?.description || d?.text || "unknown");
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
    if (res.exceptionDetails) throw new Error(`eval failed: ${res.exceptionDetails.text}`);
    return res.result?.value;
  }
  close() {
    this.ws.close();
  }
}

const WAIT = (expression, timeout = 20000) => `(async () => {
  const deadline = Date.now() + ${timeout};
  while (Date.now() < deadline) {
    const v = (() => { ${expression} })();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
})()`;

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPage() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(CDP)).json();
      const page = list.find((t) => t.type === "page" && t.url.startsWith("http://localhost:1420"));
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error("no luma CDP page");
}

/** 清偏好 + reload，并稳定等待首页渲染。 */
async function coldStart(cdp) {
  await cdp.eval(`localStorage.removeItem(${JSON.stringify(HOME_SITE_KEY)})`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  await cdp.eval(WAIT("return document.querySelector('.site-select__trigger') ? 'OK' : null;", 30000));
}

/**
 * 切站：打开 SiteSelect 下拉，点中带 data-key 的菜单项。
 * （首页站点选择已从原生 select 换成自研下拉，DOM 契约见 SiteSelect.tsx）
 */
async function selectSite(cdp, key) {
  const opened = await cdp.eval(`(() => {
    const t = document.querySelector('.site-select__trigger');
    if (!t) return 'NO_TRIGGER';
    t.click();
    return 'OPENED';
  })()`);
  if (opened !== "OPENED") return opened;
  await sleep(300);
  return cdp.eval(`(() => {
    const item = document.querySelector('.site-select__item[data-key=${JSON.stringify(key)}]');
    if (!item) return 'NO_ITEM';
    if (item.getAttribute('aria-disabled') === 'true') return 'DISABLED';
    item.click();
    return 'OK';
  })()`);
}

const snapshot = (cdp) =>
  cdp.eval(`JSON.stringify({
    selected: document.querySelector('.site-select')?.getAttribute('data-value') || null,
    cards: document.querySelectorAll('.vod-card').length,
    stored: localStorage.getItem(${JSON.stringify(HOME_SITE_KEY)}),
    empty: !!document.querySelector('.empty'),
  })`);

/**
 * 找到一个首页有 list 的站（探测前 12 个启用站，取其 key）。
 * 口径与 usableHomeSites 一致：只排除 jvm，quickjs 已解禁同样可作候选。
 */
async function findDataSite(cdp) {
  const raw = await cdp.eval(`(async () => {
    const snap = await window.__TAURI_INTERNALS__.invoke('config_active');
    const sites = (snap?.sites||[]).filter(s => s.enabled !== false && s.api && s.runtime !== 'jvm');
    for (const s of sites.slice(0, 12)) {
      try {
        const r = await Promise.race([
          window.__TAURI_INTERNALS__.invoke('spider_invoke', {request:{siteKey:s.key,method:'homeContent',args:[]}}),
          new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),8000)),
        ]);
        if ((r?.list||[]).length > 0) return JSON.stringify({key:s.key,count:(r.list||[]).length});
      } catch { /* next */ }
    }
    return JSON.stringify({key:null});
  })()`);
  return JSON.parse(raw || "{}");
}

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
console.log(`target: ${page.url}\n`);
let dataSiteKey = null;
let originalStored = null;

try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

  // 关键：先强制 reload 让 WebView2 载入最新模块，再做自检。
  // 只 setCacheDisabled 不够——窗口里可能仍跑着改代码前的旧 App.tsx
  // （有 usableHomeSites 调用却没有该 import），会报 ReferenceError 而
  // 源码自检却因 dev server 已是新代码而误判为「fresh」。曾因此整轮误报。
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000));

  // dev server 源码新鲜度自检：确认探针跑的是含自动顺延逻辑的新代码。
  const src = await fetch(
    `http://localhost:1420/src/pages/HomePage.tsx?probe=${Date.now()}`,
  )
    .then((r) => r.text())
    .catch(() => "");
  const fresh = src.includes("findHomeSiteWithList") && src.includes("isDefaultSite");
  assert(fresh, "dev server serves fresh HomePage (auto-fallback)", fresh ? "" : "stale Vite module; restart dev");
  if (!fresh) throw new Error("stale dev module; abort");

  originalStored = await cdp.eval(`localStorage.getItem(${JSON.stringify(HOME_SITE_KEY)})`);

  // 找一个首页有数据的站。
  const data = await findDataSite(cdp);
  dataSiteKey = data.key;
  assert(!!dataSiteKey, "found a site with home list data", JSON.stringify(data));
  if (!dataSiteKey) throw new Error("no site returns a home list; cannot verify");
  console.log(`[info] data site: ${dataSiteKey} (${data.count} items)\n`);

  // --- 1. 记住用户切换 ---
  await coldStart(cdp);
  assert((await selectSite(cdp, dataSiteKey)) === "OK", "switch to data site via select");
  // 切站有 300ms 防抖 + 请求；默认站本身就有卡片（frodo 修复后），
  // 「看到卡片」不再能证明切站完成——必须等 data-value 与 stored 都落到目标站。
  let switched = null;
  for (let i = 0; i < 50; i += 1) {
    switched = JSON.parse((await snapshot(cdp)) || "{}");
    if (switched.selected === dataSiteKey && switched.stored === dataSiteKey && switched.cards > 0) break;
    await sleep(400);
  }
  assert(switched?.selected === dataSiteKey, "switched to data site", JSON.stringify(switched));
  let cards = switched?.cards ?? 0;
  for (let i = 0; i < 50 && cards === 0; i += 1) {
    cards = (await cdp.eval(`document.querySelectorAll('.vod-card').length`)) || 0;
    if (cards > 0) break;
    await sleep(400);
  }
  assert(cards > 0, "data site renders cards", String(cards));
  const afterSwitch = JSON.parse((await snapshot(cdp)) || "{}");
  assert(afterSwitch.stored === dataSiteKey, "selected site persisted to localStorage", String(afterSwitch.stored));

  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  await cdp.eval(WAIT("return document.querySelector('.site-select__trigger') ? 'OK' : null;", 30000));
  // reload 后首屏请求需要几秒，立即快照会读到 cards=0。
  let afterReload = null;
  for (let i = 0; i < 50; i += 1) {
    afterReload = JSON.parse((await snapshot(cdp)) || "{}");
    if (afterReload.selected === dataSiteKey && afterReload.cards > 0) break;
    await sleep(400);
  }
  assert(afterReload?.selected === dataSiteKey, "reload keeps user-selected site", String(afterReload?.selected));
  assert(afterReload?.cards > 0, "reload keeps cards", String(afterReload?.cards));

  // --- 2. 冷启动默认站：自带内容 or 自动顺延 ---
  // py 框架对齐（修 __init__ 覆盖类属性 header）后，豆瓣默认站 homeVideoContent
  // 经 frodo 已能返回 20 条，不再是空站。「默认站自带内容」和「真空需顺延」
  // 都是正确现实，核心不变量＝冷启动后首页必有内容，且顺延发生时记住目标站。
  await coldStart(cdp); // 清偏好 → 默认站 usableSites[0]（真实配置为 py_douban）
  const cold = JSON.parse((await snapshot(cdp)) || "{}");
  console.log(`[info] cold default site: ${cold.selected}`);
  let auto = null;
  for (let i = 0; i < 75; i += 1) {
    const s = JSON.parse((await snapshot(cdp)) || "{}");
    if (s.cards > 0) {
      auto = s;
      break;
    }
    await sleep(400);
  }
  // 核心不变量：冷启动后首页一定有内容（无论默认站自带、还是顺延而来）。
  assert(!!auto && (auto.cards ?? 0) > 0, "cold start ends up with home cards", JSON.stringify(auto));
  if (auto && (auto.cards ?? 0) > 0) {
    if (auto.selected === cold.selected) {
      // 分支 A：默认站自带内容（豆瓣 frodo 修复后）→ 不该顺延、不该写偏好。
      assert(
        auto.stored === null,
        "non-empty default site stays itself, no needless fallback/remember",
        `default=${cold.selected} stored=${auto.stored}`,
      );
      console.log(`[info] default site ${cold.selected} has native home data -> no fallback (frodo fix)`);
    } else {
      // 分支 B：默认站真空 → 必须顺延到有内容站，并记住供下次启动。
      assert(
        auto.stored === auto.selected,
        "truly-empty default site auto-falls-back to a site with cards AND is remembered",
        `default=${cold.selected} selected=${auto.selected} stored=${auto.stored}`,
      );
      console.log(`[info] default site ${cold.selected} was empty -> fell back to ${auto.selected}`);
    }
  }
  // 顺延的纯决策逻辑（跳过空站/找有内容的/不超上限/失活即停）由
  // HomePage.test.tsx 的 6 个 findHomeSiteWithList 单测覆盖，不依赖真实配置形态。

  // --- 3. 尊重用户手动选站（手动选择后永久关闭自动顺延）---
  await coldStart(cdp);
  // 选一个「有数据的站」以外的站最能体现「不跳走」：py_douban 无论空/非空，
  // 手动选中后 userActedRef 置位、顺延不再介入，必须停在该站。
  assert((await selectSite(cdp, "py_douban")) === "OK", "manually select a site");
  await sleep(2500); // 等 debounce + 一次加载 + 可能的（不应发生的）顺延
  const manual = JSON.parse((await snapshot(cdp)) || "{}");
  assert(manual.selected === "py_douban", "user-selected site is NOT auto-skipped", String(manual.selected));

  assert(cdp.errors.length === 0, "no uncaught page exceptions", cdp.errors.slice(0, 3).join(" | ").slice(0, 400));
} catch (err) {
  console.log(`[diag] ${String((err && err.stack) || err)}`);
  failures += 1;
} finally {
  // 收尾：恢复用户原本记住的站（或清掉，保持探针不留痕）。
  try {
    if (originalStored) {
      await cdp.eval(`localStorage.setItem(${JSON.stringify(HOME_SITE_KEY)}, ${JSON.stringify(originalStored)})`);
    } else {
      await cdp.eval(`localStorage.removeItem(${JSON.stringify(HOME_SITE_KEY)})`);
    }
    console.log(`[info] cleanup: restored home site pref`);
  } catch {
    /* ignore */
  }
  cdp.close();
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed step(s)`);
process.exit(failures === 0 ? 0 : 1);
