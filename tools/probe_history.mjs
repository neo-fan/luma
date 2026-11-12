#!/usr/bin/env node
/**
 * 历史页回归：侧栏入口、进度/相对时间展示、单条删除（不碰用户真实记录）。
 *
 * 只在历史里插入一条合成记录（siteKey=stub_history、vodId=probe-history-1），
 * 断完就删掉它；不点「清空历史」，避免清掉用户自己的 45 条记录。
 *
 * 依赖：dev 窗口（CDP 9222）。  node tools/probe_history.mjs
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

const CARDS = `(() => {
  const cards = [...document.querySelectorAll('.fav-item')].map((el) => ({
    title: (el.querySelector('.vod-card__title')?.innerText || el.innerText || '').trim().split('\\n')[0],
    sub: (el.querySelector('.vod-card__sub')?.innerText || '').trim(),
    hasRemove: !!el.querySelector('.fav-remove'),
  }));
  return JSON.stringify(cards);
})()`;

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PROBE_NAME = "历史页探针";
const SITE_KEY = "stub_history";
const VOD_ID = "probe-history-1";

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
console.log(`target: ${page.url}`);

try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1200);
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000))) === "OK",
    "app rendered",
  );

  // 样式表守卫：dev 的 CSS HMR 偶发把 `__vite__css` 写成空串，页面会退化成
  // 无样式堆叠（DOM 断言却全部通过）。这里用「规则数 + 侧栏 flex」兜住，
  // 避免把「样式没加载」误判成布局回归。
  const css = await cdp.eval(`(() => {
    const nav = document.querySelector('.nav');
    const rules = [...document.styleSheets].reduce((sum, sheet) => {
      try { return sum + sheet.cssRules.length; } catch { return sum; }
    }, 0);
    return JSON.stringify({ rules, navDisplay: nav ? getComputedStyle(nav).display : null });
  })()`);
  const cssInfo = JSON.parse(css || "{}");
  assert(
    (cssInfo.rules ?? 0) > 100 && cssInfo.navDisplay === "flex",
    "project stylesheet applied",
    css,
  );

  // 合成一条历史：进度 50%，2 分钟时长；带线路名与集数名（播放页写入的字段）。
  const seeded = await cdp.eval(`(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke('history_upsert', {
        item: {
          siteKey: ${JSON.stringify(SITE_KEY)},
          vodId: ${JSON.stringify(VOD_ID)},
          name: ${JSON.stringify(PROBE_NAME)},
          pic: '',
          remarks: '探针',
          siteName: 'Stub History',
          playUrl: '',
          episodeName: '第 2 集',
          playFrom: '线路A',
          positionMs: 60000,
          durationMs: 120000,
          updatedAt: Date.now(),
        },
      });
      const list = await window.__TAURI_INTERNALS__.invoke('history_list');
      const top = list.find((one) => one.vodId === ${JSON.stringify(VOD_ID)});
      return JSON.stringify({
        ok: true,
        total: list.length,
        top: top?.name,
        episodeName: top?.episodeName,
        playFrom: top?.playFrom,
      });
    } catch (err) {
      return 'ERR:' + JSON.stringify(err);
    }
  })()`);
  console.log(`[info] seeded: ${seeded}`);
  assert(typeof seeded === "string" && seeded.startsWith("{"), "history entry seeded", String(seeded));

  // 侧栏 → 历史（图标也在，顺带验证入口存在）
  const nav = await cdp.eval(`(() => {
    const item = [...document.querySelectorAll('.nav__item')].find((n) => (n.getAttribute('aria-label') || n.textContent || '').includes('历史'));
    if (!item) return 'MISSING';
    item.click();
    return 'CLICKED';
  })()`);
  assert(nav === "CLICKED", "sidebar has a 历史 entry", nav);
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.vod-grid .fav-item') ? 'OK' : null;", 20000))) === "OK",
    "history page rendered",
  );

  const title = await cdp.eval(`document.querySelector('.page-title')?.innerText.trim() || ''`);
  assert(title === "历史", "page title is 历史", title);
  assert(
    (await cdp.eval(`!!document.querySelector('.page-head button')`)) === true,
    "清空历史 button present",
  );

  const cards = JSON.parse((await cdp.eval(CARDS)) || "[]");
  console.log(`[info] cards: ${JSON.stringify(cards.slice(0, 3))}`);
  const probeCard = cards.find((card) => card.title.includes(PROBE_NAME));
  assert(!!probeCard, "seeded entry listed", JSON.stringify(cards.slice(0, 3)));
  assert(
    (probeCard?.sub || "").includes("已看 50%"),
    "progress percent rendered",
    String(probeCard?.sub),
  );
  assert(
    (probeCard?.sub || "").includes("线路 线路A"),
    "line name rendered from history.playFrom",
    String(probeCard?.sub),
  );
  assert(
    (probeCard?.sub || "").includes("看到 第 2 集"),
    "episode name rendered from history.episodeName",
    String(probeCard?.sub),
  );
  assert(
    (probeCard?.sub || "").includes("刚刚"),
    "relative time rendered",
    String(probeCard?.sub),
  );
  assert(probeCard?.hasRemove === true, "each row has a delete button", String(probeCard?.hasRemove));

  // 删除这一条：只点合成记录的 ✕。
  const removed = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.fav-item')];
    const row = rows.find((el) => (el.innerText || '').includes(${JSON.stringify(PROBE_NAME)}));
    if (!row) return 'MISSING';
    const btn = row.querySelector('.fav-remove');
    if (!btn) return 'NO_BUTTON';
    btn.click();
    return 'CLICKED';
  })()`);
  assert(removed === "CLICKED", "click delete on the seeded row", removed);
  await sleep(600);
  const after = JSON.parse((await cdp.eval(CARDS)) || "[]");
  assert(
    !after.some((card) => card.title.includes(PROBE_NAME)),
    "row disappears from the list",
    JSON.stringify(after.slice(0, 3)),
  );
  const backend = await cdp.eval(`(async () => {
    const list = await window.__TAURI_INTERNALS__.invoke('history_list');
    return JSON.stringify({
      hasProbe: list.some((item) => item.siteKey === ${JSON.stringify(SITE_KEY)} && item.vodId === ${JSON.stringify(VOD_ID)}),
      total: list.length,
    });
  })()`);
  console.log(`[info] backend after delete: ${backend}`);
  assert(JSON.parse(backend).hasProbe === false, "deleted from SQLite, not just the DOM", String(backend));
} catch (err) {
  failures += 1;
  console.error(`[FAIL] probe crashed: ${err && err.message ? err.message : err}`);
  if (cdp.errors.length) {
    console.error(`[info] page errors: ${JSON.stringify(cdp.errors.slice(0, 3))}`);
  }
} finally {
  // 兜底：万一中途崩了，保证合成记录不留在用户历史里。
  try {
    await cdp.eval(
      `window.__TAURI_INTERNALS__.invoke('history_remove', { siteKey: ${JSON.stringify(SITE_KEY)}, vodId: ${JSON.stringify(VOD_ID)} }).then(() => 'OK').catch(() => 'ERR')`,
    );
  } catch {
    /* 页面已关闭时忽略 */
  }
  cdp.close();
}

console.log(failures === 0 ? "\nPASS history page" : `\nFAILED ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
