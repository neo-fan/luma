#!/usr/bin/env node
/**
 * homeVideoContent（TVBox 标准首页推荐流）端到端回归。
 *
 * 用桩服务的严格分家 fixture（/spider/strict_home.py，纯本地无网络）验证：
 *   1. strict_home.homeContent 只给 classes、list 为空（严格协议分家）；
 *   2. strict_home.homeVideoContent 返回 2 张卡片（method 链路：enum + py 白名单）；
 *   3. 首页切到该站后，前端 api.home 兜底 → UI 真出 2 张卡片 + 分类 chip 仍在
 *      （证明 mergeHomeFallback 生效、且 base.classes 不被 fallback 覆盖）；
 *   4. 真实豆瓣源作「观察项」：记录其 homeContent/homeVideoContent 的 list 数，
 *      不 FAIL —— 豆瓣 frodo 接口依赖外网。此前豆瓣稳定返回空，一度误判为
 *      「上游脚本 header 接线 bug」；2026-11-11 查明真因是我们自己的
 *      base.spider.__init__ 用实例赋值覆盖了豆瓣的类属性 header（已修，见
 *      probe_py_framework.mjs / py_base_spider_check.py）。method 可达性已在
 *      第 2 项验证，外网 frodo 结果不该绑架本探针。
 *
 * 内联导入独立配置（kind:text），收尾删除配置并恢复原 active；不改默认 active。
 */
const HOME_SITE_KEY = "luma:home:site:v1";
const STRICT_KEY = "strict_home";
const CONFIG_NAME = "probe-home-video";
const STUB = "http://127.0.0.1:8787";
const CDP = "http://127.0.0.1:9222/json/list";

const inlineConfig = JSON.stringify({
  name: CONFIG_NAME,
  sites: [
    {
      key: STRICT_KEY,
      name: "严格分家",
      type: 3,
      jar: "py",
      api: `${STUB}/spider/strict_home.py`,
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

const snapshot = (cdp) =>
  cdp.eval(`JSON.stringify({
    selected: document.querySelector('select.select')?.value || null,
    cards: document.querySelectorAll('.vod-card').length,
    chips: document.querySelectorAll('.chip:not(.chip--muted)').length,
    empty: !!document.querySelector('.empty'),
  })`);

async function waitForCards(cdp, want = 1, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last = { cards: 0 };
  while (Date.now() < deadline) {
    last = JSON.parse((await snapshot(cdp)) || "{}");
    if ((last.cards ?? 0) >= want) return last;
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

  // 先强制 reload 载最新模块，再自检（自检过≠窗口已加载新代码）。
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000));

  const bust = Date.now();
  const [invokeSrc, homeSrc] = await Promise.all([
    fetch(`http://localhost:1420/src/lib/invoke.ts?p=${bust}`).then((r) => r.text()).catch(() => ""),
    fetch(`http://localhost:1420/src/lib/home.ts?p=${bust}`).then((r) => r.text()).catch(() => ""),
  ]);
  // 泛型 <HomeResult> 会被 Vite 擦除，用转译后仍稳定的调用片段；不 fetch
  // src/types/tvbox.ts（纯 type 文件转译后为空，断言必 false）。
  const fresh =
    invokeSrc.includes('siteKey, "homeVideoContent", []') &&
    invokeSrc.includes("mergeHomeFallback") &&
    homeSrc.includes("export function mergeHomeFallback");
  assert(fresh, "dev server serves fresh homeVideoContent chain", fresh ? "" : "stale Vite module; restart dev");
  if (!fresh) throw new Error("stale dev module; abort");

  // 记住收尾要恢复的状态（active 配置 id + 首页偏好）。
  originalActiveId = await cdp.eval(
    `window.__TAURI_INTERNALS__.invoke('config_active').then(a => a ? a.id : null)`,
  );
  originalStored = await cdp.eval(`localStorage.getItem(${JSON.stringify(HOME_SITE_KEY)})`);

  // 桩服务可用性自检。
  const stubOk = await fetch(`${STUB}/spider/strict_home.py`).then((r) => r.ok).catch(() => false);
  assert(stubOk, "stub serves strict_home.py fixture", String(stubOk));
  if (!stubOk) throw new Error("stub server /spider/strict_home.py unavailable");

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
  assert(imp.ok && imp.sites >= 1, "inline strict-home config imported", imported);
  importedId = imp.id;

  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  await cdp.eval(WAIT("return document.querySelector('select.select') ? 'OK' : null;", 30000));
  const activeName = await cdp.eval(
    `window.__TAURI_INTERNALS__.invoke('config_active').then(a => a ? a.name : '')`,
  );
  assert(activeName === CONFIG_NAME, "inline config is active after reload", String(activeName));

  // 1+2. 直调两个 method：证明严格分家 + method 链路可达。
  const rpc = await cdp.eval(`(async () => {
    const call = (method) => window.__TAURI_INTERNALS__.invoke('spider_invoke',
      { request: { siteKey: ${JSON.stringify(STRICT_KEY)}, method, args: [] } });
    try {
      const a = await call('homeContent');
      const b = await call('homeVideoContent');
      return JSON.stringify({ home: { list: (a?.list||[]).length, classes: (a?.classes||[]).length },
        video: { list: (b?.list||[]).length, classes: (b?.classes||[]).length },
        names: (b?.list||[]).slice(0,2).map(v => v.vod_name) });
    } catch (e) { return JSON.stringify({ err: String(e?.message || e) }); }
  })()`);
  const r = JSON.parse(rpc || "{}");
  console.log(`[info] strict_home RPC: ${rpc}`);
  assert(!r.err, "homeContent + homeVideoContent both reachable", r.err || "");
  assert((r.home?.list ?? -1) === 0 && (r.home?.classes ?? 0) > 0,
    "strict fixture homeContent has classes but empty list", JSON.stringify(r.home));
  assert((r.video?.list ?? 0) === 2,
    "homeVideoContent method returns the recommendation list", JSON.stringify(r.video));

  // 3. UI 兜底：首页出 2 卡片 + 分类 chip 保留（base 未被覆盖）。
  const strict = await waitForCards(cdp, 2, 25000);
  assert((strict.cards ?? 0) === 2,
    "home renders 2 cards via homeVideoContent fallback", JSON.stringify(strict));
  assert((strict.chips ?? 0) >= 2,
    "home classes preserved (not overwritten by fallback)", JSON.stringify(strict));

  // 4. 真实豆瓣「观察项」：只记录，不 FAIL（frodo 依赖外网）。
  //    此时 active 是内联配置，没有豆瓣站，用真实 box 配置的 key 直调验证 method 不报错即可。
  //    豆瓣 frodo 出数据的正向断言在 probe_py_framework.mjs（框架对齐探针）。
  const doubanObs = await cdp.eval(`(async () => {
    try {
      const a = await window.__TAURI_INTERNALS__.invoke('spider_invoke',
        { request: { siteKey: 'py_douban', method: 'homeContent', args: [] } });
      return 'homeContent reachable (list=' + (a?.list||[]).length + ', classes=' + (a?.classes||[]).length + ')';
    } catch (e) { return 'not in active config: ' + String(e?.message || e).slice(0, 60); }
  })()`);
  console.log(`[observe] douban: ${doubanObs}`);

  assert(cdp.errors.length === 0, "no uncaught page exceptions", cdp.errors.slice(0, 3).join(" | ").slice(0, 400));
} catch (err) {
  console.log(`[diag] ${String((err && err.stack) || err)}`);
  failures += 1;
} finally {
  // 收尾：恢复原 active 配置、删除探针导入的配置、恢复首页偏好。
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

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed step(s)`);
process.exit(failures === 0 ? 0 : 1);
