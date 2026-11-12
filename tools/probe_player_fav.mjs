#!/usr/bin/env node
/**
 * 播放页收藏按钮回归：从历史进详情 → 点一集进播放页 → 按钮存在且真实写库。
 *
 * 只做「加一次 / 减一次」并回到初始状态：探针结束时收藏集合必须与开始时完全
 * 一致（用 favorites_list 的前后集合对比断言），不会污染用户收藏。
 * 播放页只要求挂载出 header，不强求出画（外网源不稳，出画由 artplayer /
 * playback_ux 负责）。
 *
 * 依赖：dev 窗口（CDP 9222）。  node tools/probe_player_fav.mjs
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

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 收藏集合快照：用 siteKey:vodId 拼 key，比较前后是否完全一致。 */
const FAV_KEYS = `(async () => {
  const list = await window.__TAURI_INTERNALS__.invoke('favorites_list');
  return JSON.stringify(list.map((one) => one.siteKey + ':' + one.vodId).sort());
})()`;

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

  const beforeKeys = await cdp.eval(FAV_KEYS);
  const before = new Set(JSON.parse(beforeKeys || "[]"));
  console.log(`[info] favourites before: ${before.size}`);

  // 侧栏 → 历史，取前几条真实记录轮试（有的记录详情已失效）。
  await cdp.eval(`(() => {
    const item = [...document.querySelectorAll('.nav__item')].find((n) => (n.getAttribute('aria-label') || n.textContent || '').includes('历史'));
    item?.click();
  })()`);
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.fav-item .vod-card') ? 'OK' : null;", 20000))) === "OK",
    "history page has cards",
  );

  let entered = false;
  for (let attempt = 0; attempt < 3 && !entered; attempt += 1) {
    const opened = await cdp.eval(`(() => {
      const cards = [...document.querySelectorAll('.fav-item .vod-card')];
      const card = cards[${attempt}];
      if (!card) return 'MISSING';
      card.click();
      return 'CLICKED';
    })()`);
    if (opened !== "CLICKED") {
      break;
    }
    // 详情页要么出剧集，要么出错误面板；两种都等，超时继续下一条。
    await cdp.eval(WAIT("return document.querySelector('.episode, .error-bar, .detail-title') ? 'OK' : null;", 20000));
    const hasEpisode = await cdp.eval(`(() => {
      const btn = document.querySelector('.episode');
      if (!btn) return 'NONE';
      btn.click();
      return 'CLICKED';
    })()`);
    if (hasEpisode === "CLICKED") {
      entered = true;
      break;
    }
    // 详情不可用：回上一页继续试下一条历史。
    const back = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('.page-head button')].find((n) => (n.textContent || '').includes('返回'));
      if (!btn) return 'MISSING';
      btn.click();
      return 'CLICKED';
    })()`);
    if (back !== "CLICKED") {
      break;
    }
    await sleep(1200);
  }
  assert(entered, "opened a playable detail from history");

  assert(
    (await cdp.eval(WAIT("return document.querySelector('.page--player') ? 'OK' : null;", 20000))) === "OK",
    "player page mounted",
  );
  const favBtn = await cdp.eval(WAIT(`return (() => {
    const btn = document.querySelector('.page--player .fav-star');
    if (!btn) return null;
    return JSON.stringify({ pressed: btn.getAttribute('aria-pressed'), disabled: btn.disabled });
  })();`, 15000));
  assert(!!favBtn, "player header has a favourite button", String(favBtn));
  // 收藏是剧名旁的单图标星，没有文字可读；状态一律看 aria-pressed。
  const pressed = favBtn ? JSON.parse(favBtn).pressed : null;
  assert(pressed === "false" || pressed === "true", "star exposes aria-pressed state", String(pressed));

  // 点一次：集合必须只差一条（加或删），且 aria-pressed 必须翻转。
  await cdp.eval(`document.querySelector('.page--player .fav-star').click()`);
  await sleep(600);
  const afterAdd = JSON.parse((await cdp.eval(FAV_KEYS)) || "[]");
  const added = afterAdd.filter((key) => !before.has(key));
  const removed = [...before].filter((key) => !afterAdd.includes(key));
  const flipped = await cdp.eval(
    `document.querySelector('.page--player .fav-star')?.getAttribute('aria-pressed') || ''`,
  );
  if (pressed === "false") {
    assert(added.length === 1 && removed.length === 0, "click adds exactly one favourite", JSON.stringify({ added, removed }));
    assert(flipped === "true", "star switches to favourited", flipped);
  } else {
    assert(removed.length === 1 && added.length === 0, "click removes exactly one favourite", JSON.stringify({ added, removed }));
    assert(flipped === "false", "star switches to unfavourited", flipped);
  }

  // 再点一次恢复初始状态。
  await cdp.eval(`document.querySelector('.page--player .fav-star').click()`);
  await sleep(600);
  const backKeys = JSON.parse((await cdp.eval(FAV_KEYS)) || "[]");
  assert(
    backKeys.length === before.size && backKeys.every((key) => before.has(key)),
    "favourites restored to the initial set",
    JSON.stringify({ before: before.size, after: backKeys.length }),
  );

  assert(cdp.errors.length === 0, "no uncaught exceptions", cdp.errors.join(" | "));
} catch (err) {
  failures += 1;
  console.log(`[FAIL] probe crashed: ${err.message}`);
} finally {
  cdp.close();
  console.log(failures === 0 ? "\nPASS player favourite" : `\nFAIL player favourite (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
