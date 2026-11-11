#!/usr/bin/env node
/**
 * 配置管理回归：导入时可改名（默认域名）、多份配置并存、手动切换、重命名。
 *
 * 1. 设置页输入桩配置 URL → 「配置名称」自动填成域名（127.0.0.1）；
 * 2. 改成「探针配置 A」→ 导入 → 列表新增一行且标记「当前」；
 * 3. 点原配置的「切换」→「当前」标记移回去，后端 active id 同步变化；
 * 4. 行内重命名成「探针配置 B」→ 列表立刻更新，且不会抢占 active；
 * 5. reload 后名字与 active 仍在（SQLite 落库，不是内存态）；
 * 6. 用 IPC 删掉探针配置并确认原 active 未变。
 *
 * 依赖 dev 窗口（CDP 9222）与桩服务（python tests/stub_server.py）。
 *   node tools/probe_config_manage.mjs
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

/** React 受控输入：必须走原生 setter + input 事件，直接改 value 不会触发 onChange。 */
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
  const target = nodes.find((el) => text(el) === ${JSON.stringify(label)});
  if (!target) return 'MISSING';
  target.click();
  return 'CLICKED';
})()`;

/** 配置列表快照：名字 / 来源 / 是否当前。 */
const ROWS = `(() => {
  const rows = [...document.querySelectorAll('.config-item')].map((item) => ({
    name: (item.querySelector('.config-item__name')?.innerText || '').replace('当前', '').trim(),
    meta: item.querySelector('.config-item__meta')?.innerText.trim() || '',
    active: !!item.querySelector('.config-item__tag'),
    actions: [...item.querySelectorAll('.config-item__actions button')].map((b) => b.textContent.trim()),
  }));
  return JSON.stringify(rows);
})()`;

/** 列表是异步拉的：等行数够再断言，否则读到的是「加载中」。 */
const ROWS_READY = (min = 1) =>
  WAIT(`const n = document.querySelectorAll('.config-item').length; return n >= ${min} ? n : null;`, 20000);

const NOTICE = (keyword) => `(() => {
  const tip = document.querySelector('.tip--ok');
  const text = tip ? tip.innerText.trim() : '';
  return text.includes(${JSON.stringify(keyword)}) ? text : null;
})()`;

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 带 query 的地址：桩服务按 path 路由，但配置 id 由完整 origin 哈希，
// 这样探针不会覆盖用户/其它探针已经导入的 /config.json。
const STUB = "http://127.0.0.1:8787/config.json?probe=cfg-manage";
const PROBE_NAME = "探针配置 A";
const RENAMED = "探针配置 B";

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
console.log(`target: ${page.url}`);

/** 设置页：从任意页面点侧栏进去。 */
async function openSettings() {
  const nav = await cdp.eval(`(() => {
    const item = [...document.querySelectorAll('.nav__item')].find((n) => (n.textContent || '').includes('设置'));
    if (!item) return 'MISSING';
    item.click();
    return 'CLICKED';
  })()`);
  await cdp.eval(WAIT("return document.querySelector('.settings-block') ? 'OK' : null;", 20000));
  return nav;
}

/** 通过 IPC 读后端真源，不依赖界面渲染时序。 */
async function backendState() {
  const raw = await cdp.eval(`(async () => {
    try {
      const [list, active] = await Promise.all([
        window.__TAURI_INTERNALS__.invoke('config_list'),
        window.__TAURI_INTERNALS__.invoke('config_active'),
      ]);
      return JSON.stringify({
        count: list.length,
        names: list.map((row) => row.name),
        activeId: active ? active.id : '',
        activeName: active ? active.name : '',
      });
    } catch (err) {
      return 'ERR:' + JSON.stringify(err);
    }
  })()`);
  if (typeof raw !== "string" || raw.startsWith("ERR:")) {
    throw new Error(`config_list failed: ${raw}`);
  }
  return JSON.parse(raw);
}

/** 点某一行的按钮（按行名匹配，名字去掉「当前」角标）。 */
const ROW_BUTTON = (name, label) => `(() => {
  const rows = [...document.querySelectorAll('.config-item')];
  const row = rows.find((el) =>
    (el.querySelector('.config-item__name')?.innerText || '').replace('当前', '').trim() === ${JSON.stringify(name)});
  if (!row) return 'MISSING';
  const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)});
  if (!btn) return 'NO_BUTTON';
  btn.click();
  return 'CLICKED';
})()`;

let createdId = "";
try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1200);
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000))) === "OK",
    "app rendered",
  );

  const origin = await backendState();
  console.log(`[info] before: ${JSON.stringify(origin)}`);
  assert(origin.count > 0 && origin.activeId.length > 0, "an active config exists", JSON.stringify(origin));

  assert((await openSettings()) === "CLICKED", "settings page opened");
  await cdp.eval(ROWS_READY(origin.count));
  const before = JSON.parse((await cdp.eval(ROWS)) || "[]");
  console.log(`[info] config rows before: ${JSON.stringify(before)}`);
  assert(before.length === origin.count, "config list matches the backend", `${before.length} vs ${origin.count}`);
  const originalActiveName = origin.activeName;
  assert(
    before.find((row) => row.name === originalActiveName)?.active === true,
    "active tag matches the backend",
    JSON.stringify(before),
  );

  // 1. 输入 URL → 配置名称自动取域名（127.0.0.1），不覆盖用户已改的名字。
  assert((await cdp.eval(TYPE(".search-bar input.input", STUB))) === "TYPED", "type config url");
  const autoName = await cdp.eval(
    WAIT("const el = document.querySelector('.config-name input'); return el ? el.value : null;", 5000),
  );
  assert(autoName === "127.0.0.1", "name defaults to the domain", String(autoName));

  assert((await cdp.eval(TYPE(".config-name input", PROBE_NAME))) === "TYPED", "edit config name");
  await cdp.eval(TYPE(".search-bar input.input", `${STUB}&x=1`));
  const keptName = await cdp.eval(`document.querySelector('.config-name input').value`);
  assert(keptName === PROBE_NAME, "manual name survives url edits", String(keptName));
  await cdp.eval(TYPE(".search-bar input.input", STUB));

  // 2. 导入 → 新配置成为当前。
  assert((await cdp.eval(CLICK("导入"))) === "CLICKED", "click 导入");
  const importNotice = await cdp.eval(WAIT(`return (${NOTICE("已导入")});`, 40000));
  assert(!!importNotice && importNotice.includes(PROBE_NAME), "import notice carries the custom name", String(importNotice));

  await cdp.eval(ROWS_READY(origin.count + 1));
  const afterImport = JSON.parse((await cdp.eval(ROWS)) || "[]");
  console.log(`[info] config rows after import: ${JSON.stringify(afterImport)}`);
  const added = afterImport.find((row) => row.name === PROBE_NAME);
  assert(!!added, "new config listed with the typed name", JSON.stringify(afterImport));
  assert(added?.active === true, "freshly imported config is active", JSON.stringify(added));
  assert(afterImport.length === origin.count + 1, "configs accumulate (multiple saved)", `${origin.count} -> ${afterImport.length}`);
  assert(added?.meta?.includes("127.0.0.1"), "list shows the config host", String(added?.meta));

  const afterImportBackend = await backendState();
  createdId = afterImportBackend.names.includes(PROBE_NAME) ? afterImportBackend.activeId : "";
  assert(
    createdId.length > 0 && createdId !== origin.activeId,
    "config persisted with the custom name",
    JSON.stringify(afterImportBackend),
  );

  // 3. 切回原配置。
  assert((await cdp.eval(ROW_BUTTON(originalActiveName, "切换"))) === "CLICKED", "click 切换 on the original config");
  const switchNotice = await cdp.eval(WAIT(`return (${NOTICE("已切换")});`, 30000));
  assert(!!switchNotice, "switch notice shown", String(switchNotice));
  const afterSwitch = JSON.parse((await cdp.eval(ROWS)) || "[]");
  console.log(`[info] config rows after switch: ${JSON.stringify(afterSwitch)}`);
  assert(
    afterSwitch.find((row) => row.name === originalActiveName)?.active === true,
    "active marker moved to the original config",
    JSON.stringify(afterSwitch),
  );
  assert(
    afterSwitch.find((row) => row.name === PROBE_NAME)?.active === false,
    "probe config is no longer active",
    JSON.stringify(afterSwitch),
  );
  const afterSwitchBackend = await backendState();
  assert(
    afterSwitchBackend.activeId === origin.activeId,
    "backend active id switched back",
    `${origin.activeId} -> ${afterSwitchBackend.activeId}`,
  );

  // 4. 行内重命名。
  assert((await cdp.eval(ROW_BUTTON(PROBE_NAME, "重命名"))) === "CLICKED", "click 重命名");
  assert((await cdp.eval(TYPE(".config-item__rename input", RENAMED))) === "TYPED", "type new name");
  assert((await cdp.eval(CLICK("保存"))) === "CLICKED", "click 保存");
  const renameNotice = await cdp.eval(WAIT(`return (${NOTICE("已重命名")});`, 20000));
  assert(!!renameNotice && renameNotice.includes(RENAMED), "rename notice", String(renameNotice));
  await sleep(300);
  const afterRename = JSON.parse((await cdp.eval(ROWS)) || "[]");
  console.log(`[info] config rows after rename: ${JSON.stringify(afterRename)}`);
  assert(afterRename.some((row) => row.name === RENAMED), "list shows the new name", JSON.stringify(afterRename));
  assert(!afterRename.some((row) => row.name === PROBE_NAME), "old name is gone", JSON.stringify(afterRename));
  assert(
    afterRename.find((row) => row.name === RENAMED)?.active === false,
    "renaming a non-active config does not switch it",
    JSON.stringify(afterRename),
  );

  // 5. reload 后仍在：证明写进了 SQLite，而不是 React 内存态。
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000))) === "OK",
    "reloaded",
  );
  await openSettings();
  await cdp.eval(ROWS_READY(origin.count + 1));
  const afterReload = JSON.parse((await cdp.eval(ROWS)) || "[]");
  console.log(`[info] config rows after reload: ${JSON.stringify(afterReload)}`);
  assert(afterReload.some((row) => row.name === RENAMED), "renamed config survives reload", JSON.stringify(afterReload));
  assert(
    afterReload.find((row) => row.name === originalActiveName)?.active === true,
    "active config survives reload",
    JSON.stringify(afterReload),
  );

  // 6. 清理：删掉探针配置（走 IPC，避开 window.confirm），active 保持原值。
  assert(createdId.length > 0, "probe config id known", createdId);
  if (createdId) {
    const removed = await cdp.eval(
      `window.__TAURI_INTERNALS__.invoke('config_remove', { id: ${JSON.stringify(createdId)} })
        .then(() => 'OK').catch((e) => 'ERR:' + JSON.stringify(e))`,
    );
    assert(removed === "OK", "probe config removed", String(removed));
    const finalState = await backendState();
    console.log(`[info] after cleanup: ${JSON.stringify(finalState)}`);
    assert(finalState.count === origin.count, "config count restored", `${origin.count} vs ${finalState.count}`);
    assert(!finalState.names.includes(RENAMED), "probe config gone from the backend", JSON.stringify(finalState));
    assert(finalState.activeId === origin.activeId, "original config still active", `${origin.activeId} vs ${finalState.activeId}`);
  }
} catch (err) {
  failures += 1;
  console.error(`[FAIL] probe crashed: ${err && err.message ? err.message : err}`);
  if (cdp.errors.length) {
    console.error(`[info] page errors: ${JSON.stringify(cdp.errors.slice(0, 3))}`);
  }
} finally {
  cdp.close();
}

console.log(failures === 0 ? "\nPASS config manage" : `\nFAILED ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
