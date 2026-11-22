#!/usr/bin/env node
/**
 * 播放页收藏按钮回归：搜索 → 详情 → 点一集进播放页 → 按钮存在且真实写库。
 *
 * 只做「加一次 / 减一次」并回到初始状态：探针结束时「收藏片名集合」必须与开始时
 * 完全一致，不会污染用户收藏。收藏在产品里按**片名**去重（src-tauri/src/infra/
 * store.rs toggle_favorite 会 `retain(same_title || same_vod)`，并有
 * favorite_dedupes_by_title_across_sites 单测锁定），所以给一部已在收藏里的片子
 * 点亮再取消，存储里的 siteKey:vodId 别名会合法地换成当前线路的别名——这是设计
 * 意图，不是回归。因此集合按归一化片名比对（与 src/lib/format.ts sameTitle 同口径：
 * 去掉所有空白 + 小写），而不是按 siteKey:vodId；后者不是稳定身份。
 * 播放页只要求挂载出 header，不强求出画（外网源不稳，出画由 artplayer /
 * playback_ux 负责）。
 *
 * 依赖：dev 窗口（CDP 9222）。  node tools/probes/probe_player_fav.mjs
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

/** 搜索关键词：与套件其它「真实源」探针同口径，可用 LUMA_KEYWORD 覆盖。 */
const KEYWORD = process.env.LUMA_KEYWORD || "走马上任";

/** 收藏集合快照：用归一化片名拼 key（产品按片名去重，见文件头注释），比较前后是否一致。 */const FAV_KEYS = `(async () => {
  const list = await window.__TAURI_INTERNALS__.invoke('favorites_list');
  const norm = (s) => (s == null ? '' : String(s)).replace(/\\s+/g, '').toLowerCase();
  return JSON.stringify(list.map((one) => norm(one.name)).filter(Boolean).sort());
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

  // 入口走搜索，不用历史：历史记录会随源失效而烂掉（详情空 / site not found），
  // 那样本探针会红在「找不到能播的条目」上，掩盖真正要守的东西——收藏真的写库。
  // 搜索给的是当下可用的条目，轮试前几条即可进播放页（2026-11-22 实测：
  // 历史里 6 条有名记录全部详情不可用，而搜索首条秒开）。
  await cdp.eval(`(() => {
    const item = [...document.querySelectorAll('.nav__item')].find((n) => (n.getAttribute('aria-label') || n.textContent || '').includes('搜索'));
    item?.click();
  })()`);
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.search-bar input.input') ? 'OK' : null;", 20000))) === "OK",
    "search page mounted",
  );
  assert(
    (await cdp.eval(`(() => {
      const el = document.querySelector('.search-bar input.input');
      if (!el) return 'MISSING';
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(KEYWORD)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'TYPED';
    })()`)) === "TYPED",
    "type keyword",
  );
  // 提交必须走表单 requestSubmit：`.search-bar` 里「清除」按钮排在「搜索」之前，
  // 点首个 button 会清空关键词、永不提交（SearchPage.tsx）。
  assert(
    (await cdp.eval(`(() => {
      const input = document.querySelector('.search-bar input.input');
      if (!input) return 'MISSING';
      input.closest('form').requestSubmit();
      return 'CLICKED';
    })()`)) === "CLICKED",
    "submit search",
  );
  const searched = await cdp.eval(
    WAIT("const el = document.querySelector('.result-meta'); return el && !document.querySelector('.spinner') ? el.innerText : null;", 90000),
  );
  assert(!!searched, "aggregate search finished", String(searched).slice(0, 100));
  const cardCount = Number(await cdp.eval(`document.querySelectorAll('.vod-card').length`));
  assert(cardCount > 0, "search cards rendered", `${cardCount} cards`);

  let entered = false;
  // 逐条轮试：真实源里死链常见，前几条不一定能播。仍要求真的进到播放页，
  // 不是放宽断言——只是把「哪一条能播」交给源侧。
  for (let attempt = 0; attempt < Math.min(cardCount, 6) && !entered; attempt += 1) {
    const opened = await cdp.eval(`(() => {
      const card = document.querySelectorAll('.vod-card')[${attempt}];
      if (!card) return 'MISSING';
      card.click();
      return 'CLICKED';
    })()`);
    if (opened !== "CLICKED") {
      break;
    }
    await cdp.eval(WAIT("return document.querySelector('.episode, .error-bar, .detail-title') ? 'OK' : null;", 20000));
    const clicked = await cdp.eval(`(() => {
      const btn = document.querySelector('.content .episode');
      if (!btn) return 'NONE';
      btn.click();
      return 'CLICKED';
    })()`);
    if (clicked === "CLICKED") {
      // 点完以路由真的变成 #/player/ 为准：换源/重渲染会留下旧节点。
      entered = (await cdp.eval(WAIT("return location.hash.startsWith('#/player/') ? 'OK' : null;", 15000))) === "OK";
      if (entered) break;
    }
    // 详情不可用：回上一页（搜索结果还在）继续试下一条。返回按钮是 IconButton，
    // 文案在 aria-label，不在 textContent —— 见 src/components/IconButton.tsx。
    const back = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('.page-head button')].find((n) => (n.getAttribute('aria-label') || n.textContent || '').includes('返回'));
      if (!btn) return 'MISSING';
      btn.click();
      return 'CLICKED';
    })()`);
    if (back !== "CLICKED") {
      break;
    }
    await sleep(1200);
  }
  assert(entered, "opened a playable detail from search");

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

  // 前序步骤已经红了（没进播放页）时不再硬点 DOM：那只会抛 Uncaught 把真实
  // 首因盖掉。收藏相关的断言已在前面的 assert 里各自记过失败。
  if (favBtn) {
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
  }

  assert(cdp.errors.length === 0, "no uncaught exceptions", cdp.errors.join(" | "));
} catch (err) {
  failures += 1;
  console.log(`[FAIL] probe crashed: ${err.message}`);
} finally {
  cdp.close();
  console.log(failures === 0 ? "\nPASS player favourite" : `\nFAIL player favourite (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
