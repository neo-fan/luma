#!/usr/bin/env node
/**
 * 设置页「站点体检」回归：后端并发测活 + 前端列表 + 单站禁用/启用持久化。
 *
 * 素材是桩服务 /config-py.json（带 ?probe=health 独立 origin，避免覆盖别的
 * 探针留下的同名配置）：健康 py + broken py（必失败）+ slow py（必超时）+
 * JS 屏蔽源 + 健康 CMS，一次覆盖 ok / failed / timeout / disabled 四态，
 * 全程不碰外网、不依赖真实站点波动。
 *
 * 断言：
 *   1. dev server 提供的是最新 SettingsPage（防 Vite stale 模块冒充产品 bug）；
 *   2. 设置页出现「站点体检」区块与「开始体检」按钮；
 *   3. `site_health {req:{timeoutMs:2500}}` 返回完整结构，且
 *      total == ok + failed + skipped、有 ok、有 failed/timeout、问题站排前；
 *   4. 点「开始体检」后 UI 渲染 .health-item，含可达 / 失败或超时 / 已禁用；
 *   5. 禁用一个健康站 → 该行转「已禁用」并出现「启用」按钮（onImported 换缓存）；
 *   6. reload 后从后端真源读回，该站仍禁用（跨 reload 持久化）；
 *   7. 重新启用 → 恢复为可禁用态；
 *   8. JS 屏蔽源显示「已禁用」，且其「启用」按钮 disabled；
 *   9. 无未捕获页面异常；收尾恢复原 active、删探针配置。
 *
 * 依赖：dev 窗口（CDP 9222）+ python tests/stub_server.py（8787）。
 *   node tools/probe_settings_health.mjs
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WAIT = (expression, timeout = 15000) => `(async () => {
  const deadline = Date.now() + ${timeout};
  while (Date.now() < deadline) {
    const value = (() => { ${expression} })();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
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

/** 侧栏按钮用 aria-label 定位最稳：收缩态文字被 CSS 隐藏也仍有 aria-label。 */
const CLICK_NAV = (label) => `(() => {
  const el = document.querySelector('.nav__item[aria-label="${label}"]')
    || [...document.querySelectorAll('.nav__item')].find((n) => (n.textContent || '').trim().includes(${JSON.stringify(label)}));
  if (!el) return 'MISSING';
  el.click();
  return 'CLICKED';
})()`;

/** 读设置页标题，用来确认点侧栏后真的切到了设置页（而非旧文档残留）。 */
const SETTINGS_TITLE = `(() => {
  const t = document.querySelector('.page-title');
  return t && t.textContent.includes('设置') ? 'OK' : null;
})()`;

/** 读体检区块渲染快照：行、状态、按钮文案与禁用态。 */
const HEALTH_UI = `(() => {
  const block = [...document.querySelectorAll('.settings-block')]
    .find((b) => (b.querySelector('.section-title')?.textContent || '').includes('站点体检'));
  if (!block) return JSON.stringify({ missing: true });
  const items = [...block.querySelectorAll('.health-item')].map((el) => ({
    name: el.querySelector('.health-item__name')?.textContent.trim() || '',
    status: el.querySelector('.health-item__status')?.textContent.trim() || '',
    statusClass: el.querySelector('.health-item__status')?.className || '',
    buttons: [...el.querySelectorAll('button')].map((b) => ({
      text: b.textContent.trim(), disabled: b.disabled,
    })),
  }));
  return JSON.stringify({
    items,
    summary: block.querySelector('.health-summary')?.textContent.trim() || '',
    hasStart: [...block.querySelectorAll('button')].some((b) => b.textContent.includes('开始体检')),
    bodyError: block.querySelector('.error-bar')?.textContent.trim() || '',
  });
})()`;

/** 轮询式等待，返回满足条件的表达式结果；expr 必须是完整 IIFE 字符串。 */
async function until(cdp, expr, predicate, timeout, interval = 250) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.eval(expr);
    if (predicate(last)) return last;
    await sleep(interval);
  }
  return last;
}

/** reload + 稳定等待：Page.reload 返回不等于新文档就绪，先睡一帧再等侧栏。 */
async function reloadReady(cdp) {
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  return cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000));
}

/** 点侧栏「设置」并确认真的切到设置页，失败时带侧栏快照便于定位。 */
async function openSettings(cdp, label) {
  const clicked = await cdp.eval(CLICK_NAV("设置"));
  if (clicked !== "CLICKED") {
    const nav = await cdp.eval(
      `JSON.stringify([...document.querySelectorAll('.nav__item')].map((n) => ({ aria: n.getAttribute('aria-label'), text: (n.textContent||'').trim() })))`,
    );
    assert(false, label, `${clicked} nav=${nav}`);
    return false;
  }
  const title = await until(cdp, SETTINGS_TITLE, (v) => v === "OK", 15000);
  assert(title === "OK", label, String(title));
  return title === "OK";
}

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const CONFIG = "http://127.0.0.1:8787/config-py.json?probe=health";
const PROBE_NAME = "体检探针配置";
const HEALTHY_SITE = "stub_py";

/** 从当前 active 快照按 key 读站点 enabled / disabledReason（完整 async IIFE）。 */
const SITE_STATE = (key) => `(async () => {
  const snap = await window.__TAURI_INTERNALS__.invoke('config_active');
  const site = snap.sites.find((s) => s.key === ${JSON.stringify(key)});
  return site ? JSON.stringify({ enabled: site.enabled, reason: site.disabledReason || '' }) : 'MISSING';
})()`;

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
console.log(`target: ${page.url}`);

let previousActive = "";
try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

  // 源码新鲜度自检：Vite 转换缓存曾让探针跑在旧 SettingsPage 上、误判功能没做。
  const fresh = await cdp.eval(`fetch('http://localhost:1420/src/pages/SettingsPage.tsx?t=' + Date.now())
    .then((r) => r.text())
    .then((t) => JSON.stringify({ block: t.includes('站点体检'), cls: t.includes('health-item') }))
    .catch((e) => JSON.stringify({ err: String(e) }))`);
  console.log(`[info] dev source freshness: ${fresh}`);
  const freshObj = typeof fresh === "string" ? JSON.parse(fresh) : {};
  assert(freshObj.block === true && freshObj.cls === true, "dev server serves fresh SettingsPage", String(fresh));

  assert((await reloadReady(cdp)) === "OK", "app rendered");

  previousActive = await cdp.eval(
    `window.__TAURI_INTERNALS__.invoke('config_active').then((s) => (s ? s.id : ''))`,
  );
  console.log(`[info] previous active: ${previousActive}`);

  // 导入独立配置（?probe=health），保证不覆盖真实 box 与其它探针的配置。
  const imported = await cdp.eval(`(async () => {
    try {
      const snap = await window.__TAURI_INTERNALS__.invoke('config_import', {
        source: { kind: 'url', value: ${JSON.stringify(CONFIG)}, name: ${JSON.stringify(PROBE_NAME)} },
      });
      return JSON.stringify({
        id: snap.id,
        total: snap.sites.length,
        enabled: snap.sites.filter((s) => s.enabled).length,
        blocked: snap.sites.filter((s) => s.disabledReason).length,
      });
    } catch (err) {
      return 'ERR:' + JSON.stringify(err);
    }
  })()`);
  console.log(`[info] imported: ${imported}`);
  const importedObj = typeof imported === "string" && imported.startsWith("{") ? JSON.parse(imported) : null;
  assert(!!importedObj && importedObj.total >= 5, "probe config imported with all site kinds", String(imported));
  assert(!!importedObj && importedObj.blocked >= 1, "JS source blocked at import", String(imported));

  // 用导入后的配置重载，进设置页，确认体检区块与按钮存在。
  assert((await reloadReady(cdp)) === "OK", "reloaded with probe config active");
  if (!(await openSettings(cdp, "open settings page"))) throw new Error("cannot open settings page");
  const blockReady = await cdp.eval(
    WAIT(
      "const b = [...document.querySelectorAll('.settings-block')].find((x) => x.textContent.includes('站点体检')); return b ? 'OK' : null;",
      20000,
    ),
  );
  assert(blockReady === "OK", "站点体检 block rendered", String(blockReady));
  const ui0 = JSON.parse((await cdp.eval(HEALTH_UI)) || "{}");
  assert(ui0.hasStart === true, "开始体检 button present", JSON.stringify(ui0));
  assert((ui0.items || []).some((r) => r.status === "已禁用"), "blocked site shown as 已禁用 before probe", JSON.stringify(ui0.items));

  // 后端命令直调：验证结构、计数恒等式、四态覆盖与排序。
  const healthRaw = await cdp.eval(`(async () => {
    try {
      const r = await window.__TAURI_INTERNALS__.invoke('site_health', { req: { timeoutMs: 2500 } });
      return JSON.stringify(r);
    } catch (err) { return 'ERR:' + JSON.stringify(err); }
  })()`);
  console.log(`[info] site_health: ${String(healthRaw).slice(0, 900)}`);
  const health = typeof healthRaw === "string" && healthRaw.startsWith("{") ? JSON.parse(healthRaw) : null;
  assert(!!health && typeof health.configId === "string" && health.configId.length > 0, "site_health returns configId", String(health?.configId));
  assert(
    !!health && health.total === health.ok + health.failed + health.skipped,
    "total == ok + failed + skipped",
    JSON.stringify({ total: health?.total, ok: health?.ok, failed: health?.failed, skipped: health?.skipped }),
  );
  assert(!!health && health.ok >= 1, "at least one reachable site", `ok=${health?.ok}`);
  assert(
    !!health && health.failed + health.skipped >= 1,
    "at least one failed/timeout/skipped site",
    `failed=${health?.failed} skipped=${health?.skipped}`,
  );
  assert(!!health && Array.isArray(health.rows) && health.rows.length === health.total, "rows length == total", `${health?.rows?.length}/${health?.total}`);
  if (health?.rows?.length) {
    const rank = (s) => ({ failed: 0, timeout: 1, skipped: 2, ok: 3 }[s] ?? 4);
    let sorted = true;
    for (let i = 1; i < health.rows.length; i += 1) {
      if (rank(health.rows[i - 1].status) > rank(health.rows[i].status)) { sorted = false; break; }
    }
    assert(sorted, "problematic sites sorted before healthy ones", JSON.stringify(health.rows.map((r) => r.status)));
    const okRow = health.rows.find((r) => r.status === "ok");
    assert(!!okRow && typeof okRow.tookMs === "number", "ok row carries tookMs", JSON.stringify(okRow));
  }

  // UI 点「开始体检」→ 列表渲染四态。
  assert((await cdp.eval(CLICK("开始体检", ".settings-block button"))) === "CLICKED", "click 开始体检");
  const ui1Raw = await until(cdp, HEALTH_UI, (raw) => {
    const p = typeof raw === "string" ? JSON.parse(raw) : {};
    return (p.items || []).length >= 5;
  }, 60000, 300);
  const ui1 = typeof ui1Raw === "string" ? JSON.parse(ui1Raw) : {};
  console.log(`[info] health UI after probe: ${JSON.stringify(ui1).slice(0, 900)}`);
  assert((ui1.items || []).length >= 5, "health rows rendered in UI", `${ui1.items?.length} rows`);
  assert(!!ui1.summary && /共\s*\d+\s*站/.test(ui1.summary), "summary line rendered", String(ui1.summary));
  const statuses = (ui1.items || []).map((r) => r.status);
  assert(statuses.includes("可达"), "healthy site shows 可达", JSON.stringify(statuses));
  assert(statuses.some((s) => s === "失败" || s === "超时"), "broken/slow site shows 失败 or 超时", JSON.stringify(statuses));
  assert(statuses.includes("已禁用"), "blocked site shows 已禁用", JSON.stringify(statuses));
  const blockedRow = (ui1.items || []).find((r) => r.status === "已禁用" && r.buttons?.some((b) => b.text === "启用" && b.disabled));
  assert(!!blockedRow, "blocked source 启用 button disabled", JSON.stringify(blockedRow));

  // 禁用一个健康站：点到该行的「禁用」按钮。
  const healthyRow = (ui1.items || []).find((r) => r.status === "可达" && r.buttons?.some((b) => b.text === "禁用"));
  assert(!!healthyRow, "found a healthy site to disable", JSON.stringify(healthyRow));
  const disableHealthy = `(() => {
    const items = [...document.querySelectorAll('.health-item')];
    const row = items.find((el) => {
      const st = el.querySelector('.health-item__status')?.textContent.trim();
      const btn = [...el.querySelectorAll('button')].some((b) => b.textContent.trim() === '禁用');
      return st === '可达' && btn;
    });
    if (!row) return 'MISSING';
    [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '禁用').click();
    return 'CLICKED';
  })()`;
  assert((await cdp.eval(disableHealthy)) === "CLICKED", "click 禁用 on healthy site");
  const disabledState = await until(cdp, SITE_STATE(HEALTHY_SITE), (raw) => {
    return typeof raw === "string" && raw.startsWith("{") && JSON.parse(raw).enabled === false;
  }, 10000);
  console.log(`[info] backend state after disable: ${disabledState}`);
  assert(
    typeof disabledState === "string" && disabledState.startsWith("{") && JSON.parse(disabledState).enabled === false,
    "site_set_enabled persisted disable to backend",
    String(disabledState),
  );

  // reload 后从后端真源读回：仍禁用（跨 reload 持久化）。
  assert((await reloadReady(cdp)) === "OK", "reloaded after disable");
  const afterReload = await cdp.eval(SITE_STATE(HEALTHY_SITE));
  console.log(`[info] backend state after reload: ${afterReload}`);
  assert(
    typeof afterReload === "string" && afterReload.startsWith("{") && JSON.parse(afterReload).enabled === false,
    "disable survives reload (backend is source of truth)",
    String(afterReload),
  );

  // 重新启用：再进设置页点该行的「启用」（reload 后 healthRows 清空，禁用站由前端从 sites 合成）。
  if (!(await openSettings(cdp, "open settings again"))) throw new Error("cannot reopen settings page");
  // 禁用站来自 sites 合成、依赖 App 的 configActive 回填，渲染略晚；用 until
  // 轮询「可点的启用按钮」本体，同时作为存在性断言与点击目标，消除两步竞态。
  const clickEnable = `(() => {
    const items = [...document.querySelectorAll('.health-item')];
    const row = items.find((el) => (el.querySelector('.health-item__status')?.textContent.trim() || '') === '已禁用'
      && [...el.querySelectorAll('button')].some((b) => b.textContent.trim() === '启用' && !b.disabled));
    if (!row) return 'MISSING';
    [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '启用' && !b.disabled).click();
    return 'CLICKED';
  })()`;
  const enableClick = await until(cdp, clickEnable, (v) => v === "CLICKED", 20000, 300);
  assert(enableClick === "CLICKED", "disabled site has an enabled 启用 button and it was clicked", String(enableClick));
  const reEnabled = await until(cdp, SITE_STATE(HEALTHY_SITE), (raw) => {
    return typeof raw === "string" && raw.startsWith("{") && JSON.parse(raw).enabled === true;
  }, 10000);
  console.log(`[info] backend state after re-enable: ${reEnabled}`);
  assert(typeof reEnabled === "string" && reEnabled.startsWith("{"), "site re-enabled on backend", String(reEnabled));

  assert(cdp.errors.length === 0, "no uncaught page exceptions", cdp.errors.slice(0, 3).join(" | ").slice(0, 600));
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

console.log(failures === 0 ? "\nPASS settings health" : `\nFAILED ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
