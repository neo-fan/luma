#!/usr/bin/env node
/**
 * py 框架与 TVBox 原生对齐的窗口端到端回归（真实 Rust -> pyspider -> pyrun -> base.spider 链路）。
 *
 * 核心是回归「__init__ 不得用实例赋值覆盖子类 header 类属性」这一根因：
 * 豆瓣 / 4KAV / 杉札 / 短片 / 农民影视 / 嗨皮影视 6 站用类属性声明自定义
 * header，旧框架把它吞成 okhttp/3.15 -> 豆瓣 frodo 400 -> 首页空。
 *
 * 断言（尽量不依赖外网）：
 *   1. header_probe（继承真实 base.spider.Spider、类属性 header、纯本地桩）
 *      经 spider_invoke 回显的 vod_name == "LumaProbeUA|class-attr-alive"，
 *      证明类属性 header 在真实链路下没被 __init__ 覆盖（本地稳定硬断言）；
 *   2. header_probe.homeContent 只给 class、list 空（严格分家 fixture 复用）；
 *   3. 首页切到 header_probe，前端 homeVideoContent 兜底出 1 卡片，且卡片名
 *      回显 "LumaProbeUA"（证明 UI 链路也走修复后的框架），分类 chip 保留；
 *   4. 真实豆瓣 py_douban.homeVideoContent 经 frodo 返回 >0 条（header 修复
 *      铁证，依赖外网；连不上记观察不 FAIL，但框架链路断言已由 1/3 覆盖）；
 *   5. 无未捕获页面异常。
 *
 * 内联导入独立配置（kind:text），收尾删配置、恢复原 active 与首页偏好。
 */
const HOME_SITE_KEY = "luma:home:site:v1";
const PROBE_KEY = "header_probe";
const CONFIG_NAME = "probe-py-framework";
const STUB = "http://127.0.0.1:8787";
const CDP = "http://127.0.0.1:9222/json/list";
const EXPECT_ECHO = "LumaProbeUA|class-attr-alive";

const inlineConfig = JSON.stringify({
  name: CONFIG_NAME,
  sites: [
    {
      key: PROBE_KEY,
      name: "框架探针",
      type: 3,
      jar: "py",
      api: `${STUB}/spider/header_probe.py`,
      ext: "",
      searchable: 1,
      quickSearch: 1,
      filterable: 1,
    },
  ],
});

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
let observations = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const observe = (label, detail = "") => {
  console.log(`[obs ] ${label}${detail ? `  -- ${detail}` : ""}`);
  observations += 1;
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

// 首页内容三形态（契约 3）：头图 .home-hero、推荐海报 .poster-tile、分类网格 .vod-card。
// header_probe 的 homeVideoContent 只有 1 条 → 走推荐 tab 的 .home-hero，旧口径只认
// .vod-card 必然取空。这里按形态读标题载体：.home-hero__title / .poster-tile__title /
// .vod-card__title，三选一都覆盖到，语义（卡片名回显 UA）不变，只是寻址对齐当前 DOM。
const HOME_TITLE_SELECTOR = ".home-hero__title, .poster-tile__title, .vod-card__title";

const snapshot = (cdp) =>
  cdp.eval(`JSON.stringify({
    selected: document.querySelector('.app-select--site')?.getAttribute('data-value') || null,
    cards: [...document.querySelectorAll(${JSON.stringify(HOME_TITLE_SELECTOR)})].map(c => c.textContent || ''),
    chips: document.querySelectorAll('.chip:not(.chip--muted)').length,
    empty: !!document.querySelector('.empty'),
  })`);

// 切站后 React 会短暂保留上一份配置的旧卡片，只等"卡片数 >= 1"会拿到旧 DOM 误判
// （RPC 层已证明 header 生效）。因此可选地等到目标文本真正渲染；等不到仍按失败返回，不放宽断言。
async function waitForCards(cdp, want = 1, timeoutMs = 25000, expectText = "") {
  const deadline = Date.now() + timeoutMs;
  let last = { cards: [] };
  while (Date.now() < deadline) {
    last = JSON.parse((await snapshot(cdp)) || "{}");
    const names = (last.cards ?? []).join(" ");
    if ((last.cards ?? []).length >= want && (!expectText || names.includes(expectText))) return last;
    await sleep(400);
  }
  return last;
}

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
console.log(`target: ${page.url}\n`);
let originalActiveId = null;
let originalStored = null;
let importedId = null;

try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

  // 强制 reload 载最新前端模块，再等页面就绪。
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000));

  // 桩服务 fixture 可用性自检。
  const stubOk = await fetch(`${STUB}/spider/header_probe.py`).then((r) => r.ok).catch(() => false);
  assert(stubOk, "stub serves header_probe.py", String(stubOk));
  if (!stubOk) throw new Error("stub /spider/header_probe.py unavailable");

  // 记住收尾要恢复的状态（active 配置 id + 首页偏好）。
  originalActiveId = await cdp.eval(
    `window.__TAURI_INTERNALS__.invoke('config_active').then(a => a ? a.id : null)`,
  );
  originalStored = await cdp.eval(`localStorage.getItem(${JSON.stringify(HOME_SITE_KEY)})`);

  // 导入独立内联配置，reload 让 App 从 config_active 对齐 sites。
  const imported = await cdp.eval(`(async () => {
    try {
      const snap = await window.__TAURI_INTERNALS__.invoke('config_import', {
        source: { kind: 'text', value: ${JSON.stringify(inlineConfig)}, name: ${JSON.stringify(CONFIG_NAME)} },
      });
      return JSON.stringify({ ok: true, id: snap.id, sites: (snap.sites || []).length });
    } catch (e) { return JSON.stringify({ ok: false, err: String(e && e.message || e) }); }
  })()`);
  const imp = JSON.parse(imported);
  assert(imp.ok && imp.sites >= 1, "inline header-probe config imported", imported);
  importedId = imp.id;

  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  await cdp.eval(WAIT("return document.querySelector('.app-select--site .app-select__trigger') ? 'OK' : null;", 30000));
  const activeName = await cdp.eval(
    `window.__TAURI_INTERNALS__.invoke('config_active').then(a => a ? a.name : '')`,
  );
  assert(activeName === CONFIG_NAME, "inline config is active after reload", String(activeName));

  // 1+2. 经真实链路直调两个 method：回显 header + 严格分家。
  const rpc = await cdp.eval(`(async () => {
    const call = (method) => window.__TAURI_INTERNALS__.invoke('spider_invoke',
      { request: { siteKey: ${JSON.stringify(PROBE_KEY)}, method, args: [] } });
    try {
      const a = await call('homeContent');
      const b = await call('homeVideoContent');
      return JSON.stringify({
        home: { list: (a?.list||[]).length, classes: (a?.classes||[]).length },
        video: { list: (b?.list||[]).length, names: (b?.list||[]).slice(0,2).map(v => v.vod_name) },
      });
    } catch (e) { return JSON.stringify({ err: String(e?.message || e) }); }
  })()`);
  const r = JSON.parse(rpc || "{}");
  console.log(`[info] header_probe RPC: ${rpc}`);
  assert(!r.err, "header_probe homeContent + homeVideoContent reachable", r.err || "");
  assert((r.home?.list ?? -1) === 0 && (r.home?.classes ?? 0) > 0,
    "class-attr fixture homeContent classes-only", JSON.stringify(r.home));
  assert((r.video?.list ?? 0) === 1 && r.video?.names?.[0] === EXPECT_ECHO,
    "class-attribute header survives real pyrun chain (ROOT CAUSE FIXED)",
    `expected "${EXPECT_ECHO}", got ${JSON.stringify(r.video?.names)}`);

  // 3. UI 兜底：切到 header_probe，出 1 卡片且卡片名回显自定义 UA，分类 chip 保留。
  //    站点选择已是自研下拉（SiteSelect）：点触发器 → 点 data-key 菜单项。
  await cdp.eval(`(() => {
    const t = document.querySelector('.app-select--site .app-select__trigger');
    if (!t) return 'NO_TRIGGER';
    t.click();
    return 'OPENED';
  })()`);
  await sleep(300);
  await cdp.eval(`(() => {
    // 菜单 Portal 到 body，用常量无障碍名 scope，避免选到常驻直播层等其它下拉。
    const item = document.querySelector('.app-select__menu[aria-label="选择站点"] .app-select__item[data-value=${JSON.stringify(PROBE_KEY)}]');
    if (!item) return 'NO_ITEM';
    item.click();
    return 'OK';
  })()`);
  const ui = await waitForCards(cdp, 1, 25000, "LumaProbeUA");
  const names = (ui.cards || []).join(" ");
  assert((ui.cards ?? []).length >= 1, "UI renders card via homeVideoContent fallback", JSON.stringify(ui));
  assert(names.includes("LumaProbeUA"), "UI card echoes custom class-attr header UA", names.slice(0, 160));
  assert((ui.chips ?? 0) >= 1, "UI classes chip preserved (base not overwritten)", JSON.stringify(ui.chips));

  // 4. 真实豆瓣 frodo（外网）：正向观察——框架修好后应 >0 条。
  //    先激活真实配置里的豆瓣站不可行（active 是内联配置），直接用真实 box 配置的 key。
  //    若该 key 不在当前 active，spider_invoke 会报 not found，此步降级为观察。
  const douban = await cdp.eval(`(async () => {
    try {
      const b = await window.__TAURI_INTERNALS__.invoke('spider_invoke',
        { request: { siteKey: 'py_douban', method: 'homeVideoContent', args: [] } });
      return JSON.stringify({ ok: true, list: (b?.list||[]).length });
    } catch (e) { return JSON.stringify({ ok: false, err: String(e?.message || e).slice(0, 80) }); }
  })()`);
  const db = JSON.parse(douban || "{}");
  if (db.ok && (db.list ?? 0) > 0) {
    assert(true, "real douban homeVideoContent via frodo (header fix)", `list=${db.list}`);
  } else {
    // 豆瓣 frodo 是外网加值项，核心 header 铁证已由第 1/3 项本地桩覆盖；
    // 外网抖动/站点不在 active/接口变更都只记观察，不让本探针变红。
    observe("real douban frodo not asserted (external)", db.ok ? `list=${db.list}` : (db.err || ""));
  }

  assert(cdp.errors.length === 0, "no uncaught page exceptions", cdp.errors.slice(0, 3).join(" | ").slice(0, 400));
} catch (err) {
  console.log(`[diag] ${String((err && err.stack) || err)}`);
  failures += 1;
} finally {
  try {
    if (originalActiveId) {
      await cdp.eval(
        `window.__TAURI_INTERNALS__.invoke('config_activate', { id: ${JSON.stringify(originalActiveId)} })`,
      );
    }
    if (importedId) {
      await cdp.eval(
        `window.__TAURI_INTERNALS__.invoke('config_remove', { id: ${JSON.stringify(importedId)} })`,
      );
    }
    if (originalStored) {
      await cdp.eval(`localStorage.setItem(${JSON.stringify(HOME_SITE_KEY)}, ${JSON.stringify(originalStored)})`);
    } else {
      await cdp.eval(`localStorage.removeItem(${JSON.stringify(HOME_SITE_KEY)})`);
    }
    console.log(`[info] cleanup: active restored, probe config removed, home pref restored`);
  } catch (err) {
    console.log(`[warn] cleanup partial: ${String(err)}`);
  }
  cdp.close();
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed step(s), ${observations} observation(s)`);
process.exit(failures === 0 ? 0 : 1);
