#!/usr/bin/env node
/**
 * 最近搜索词（最多 10 条）窗口回归：
 *   1. 存储里塞 12 条 → reload，只渲染 10 条且最新在前；
 *   2. 点历史词 → 输入框回填 + 该词被提到最前（不等 20s 聚合搜索，立刻 reload 打断）；
 *   3. 单条删除 / 清空 → DOM 与 localStorage 同步；
 *   4. 无未捕获页面异常，收尾恢复用户原有历史。
 *
 * 依赖 dev 窗口（CDP 9222）。  node tools/probes/probe_search_history.mjs
 */
const KEY = "luma:search:history:v1";
// 存储数组约定：首位 = 最新。造 12 条时倒序写，词12 最新、词1 最旧。
const WORDS = Array.from({ length: 12 }, (_, i) => `词${12 - i}`);

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
    if (res.exceptionDetails) throw new Error(`eval failed: ${res.exceptionDetails.text}`);
    return res.result?.value;
  }

  close() {
    this.ws.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAIT = (expression, timeout = 15000) => `(async () => {
  const deadline = Date.now() + ${timeout};
  while (Date.now() < deadline) {
    const value = (() => { ${expression} })();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
})()`;

async function waitForPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
      const page = list.find(
        (t) => t.type === "page" && t.webSocketDebuggerUrl && t.url.startsWith("http://localhost:1420"),
      );
      if (page) return page;
    } catch {
      /* window not up yet */
    }
    await sleep(1000);
  }
  throw new Error("CDP page target not found");
}

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const SNAPSHOT = `JSON.stringify({
  chips: [...document.querySelectorAll('.recent-chip__word')].map(b => (b.textContent || '').trim()),
  keyword: document.querySelector('.search-bar input.input')?.value ?? null,
  hasPanel: !!document.querySelector('.recent-searches'),
})`;

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
console.log(`target: ${page.url}\n`);
let original = null;

const reload = async () => {
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1200);
  await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000));
};

const gotoSearch = async () => {
  const clicked = await cdp.eval(
    WAIT(
      "const n = [...document.querySelectorAll('.nav__item')].find(x => (x.textContent || '').includes('搜索')); if (!n) return null; n.click(); return 'OK';",
      15000,
    ),
  );
  if (!clicked) throw new Error("search nav not found");
  await cdp.eval(WAIT("return document.querySelector('.search-bar') ? 'OK' : null;", 15000));
};

const readStored = async () =>
  JSON.parse((await cdp.eval(`localStorage.getItem(${JSON.stringify(KEY)})`)) || "[]");

try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  original = await cdp.eval(`localStorage.getItem(${JSON.stringify(KEY)})`);

  // 1. 超量历史：清洗后只留 10 条，最新在前、最旧的 2 条丢弃。
  await cdp.eval(`localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify(WORDS))})`);
  await reload();
  await gotoSearch();
  const first = JSON.parse((await cdp.eval(SNAPSHOT)) || "{}");
  assert(first.chips.length === 10, "最多渲染 10 个最近搜索词", `chips=${first.chips.length}`);
  assert(
    first.chips[0] === "词12" && first.chips[9] === "词3",
    "最新在前，超出的最旧两条被丢弃",
    `${first.chips[0]} … ${first.chips[9]}`,
  );

  // 2. 点最旧一条：回填输入框 + 重新提到最前（证明点击确实触发了一次搜索）。
  const picked = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('.recent-chip__word')].find(x => (x.textContent || '').trim() === '词3');
    if (!b) return 'MISSING';
    b.click();
    return 'OK';
  })()`);
  assert(picked === "OK", "历史词可点击", String(picked));
  const filled = await cdp.eval(
    WAIT("const i = document.querySelector('.search-bar input.input'); return i && i.value === '词3' ? 'OK' : null;", 8000),
  );
  assert(filled === "OK", "点击后回填搜索框", String(filled));
  const stored = await readStored();
  assert(
    stored[0] === "词3" && stored.length === 10,
    "点击重搜后该词提到最前且仍为 10 条",
    `${stored[0]} / ${stored.length}`,
  );
  // 后台聚合搜索会跑满 20s，reload 打断它，避免拖慢后续探针。
  await reload();
  await gotoSearch();

  // 3. 单条删除。
  await cdp.eval(`document.querySelector('.recent-chip__remove').click()`);
  const afterRemove = await cdp.eval(
    WAIT("return document.querySelectorAll('.recent-chip__word').length === 9 ? 'OK' : null;", 8000),
  );
  assert(afterRemove === "OK", "单条删除从列表移除", String(afterRemove));
  assert((await readStored()).length === 9, "单条删除同步落盘");

  // 4. 清空（图标按钮，按 aria-label 定位）。
  const cleared = await cdp.eval(`(() => {
    const b = document.querySelector('.recent-searches__head button[aria-label="清空最近搜索"]');
    if (!b) return 'MISSING';
    b.click();
    return 'OK';
  })()`);
  assert(cleared === "OK", "清空按钮存在", String(cleared));
  const gone = await cdp.eval(
    WAIT("return !document.querySelector('.recent-searches') ? 'OK' : null;", 8000),
  );
  assert(gone === "OK", "清空后历史区消失", String(gone));
  assert((await readStored()).length === 0, "清空后存储为空");

  assert(cdp.errors.length === 0, "无未捕获页面异常", cdp.errors[0] || "");
} catch (err) {
  assert(false, "probe 执行异常", String(err?.message || err));
} finally {
  // 恢复用户原有历史并 reload，避免污染下一支探针。
  try {
    await cdp.eval(`(() => {
      const v = ${JSON.stringify(original)};
      if (v === null) localStorage.removeItem(${JSON.stringify(KEY)});
      else localStorage.setItem(${JSON.stringify(KEY)}, v);
    })()`);
    await reload();
  } catch {
    /* best effort */
  }
  cdp.close();
}

console.log(`\n${failures ? `FAIL: ${failures} failed step(s)` : "PASS: 0 failed step(s)"}`);
process.exit(failures ? 1 : 0);
