#!/usr/bin/env node
/**
 * 首页分类 chip 必须「原地换下方网格」，不能 push 二级页面。
 *
 * 断言顺序刻意放在真实窗口里：源码契约只能保证没写 navigate，但保证不了
 * 「点完 chip 页面标题还是首页、没有返回键、分页条还在」。用真实配置跑，
 * 不需要桩服务；收尾点回「推荐」恢复现场。
 */
const CDP = "http://127.0.0.1:9222/json/list";

async function waitForPage(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(CDP)).json();
      const page = list.find((t) => t.type === "page" && t.url.startsWith("http://localhost:1420"));
      if (page) return page;
    } catch {
      /* CDP not up yet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("CDP page target not found");
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
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
      const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 45000);
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

const WAIT = (body, timeout = 25000) => `(async () => {
  const deadline = Date.now() + ${timeout};
  while (Date.now() < deadline) {
    const v = (() => { ${body} })();
    if (v) return v;
    await new Promise(r => setTimeout(r, 150));
  }
  return null;
})()`;

const SNAP = `JSON.stringify({
  title: document.querySelector('.page-title')?.textContent?.trim(),
  backBtn: !!document.querySelector('.page-head .icon-btn[aria-label="返回"]'),
  activeChip: document.querySelector('.chip.is-active')?.textContent?.trim(),
  pager: document.querySelector('.pager__label')?.textContent?.trim() || null,
  cards: document.querySelectorAll('.vod-card').length,
  recommendChip: [...document.querySelectorAll('.chip-row .chip')].some(c => c.textContent.trim() === '推荐'),
})`;

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
console.log(`target: ${page.url}`);

try {
  await cdp.send("Page.enable");
  await cdp.send("Page.reload", { ignoreCache: true });
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.page-title')?.textContent?.trim() === '首页' ? 'OK' : null;", 30000))) === "OK",
    "home rendered",
  );
  // 重载后首页数据是异步的：分类 chip 与卡片都要等它落地，否则会读到空 chip-row。
  assert(
    (await cdp.eval(WAIT("return document.querySelectorAll('.vod-card').length > 0 || !!document.querySelector('.empty') ? 'OK' : null;", 30000))) === "OK",
    "home content settled",
  );
  // 确保从「推荐」起步，不被上一次运行留下的选中态影响。
  await cdp.eval(`(() => { const c=[...document.querySelectorAll('.chip-row .chip')].find(x=>x.textContent.trim()==='推荐'); c&&c.click(); return true; })()`);
  await sleep(600);

  const before = JSON.parse(await cdp.eval(SNAP));
  console.log(`[info] before: ${JSON.stringify(before)}`);
  assert(before.activeChip === "推荐", "推荐 chip is active by default", JSON.stringify(before));
  assert(before.recommendChip === true, "推荐 chip present", JSON.stringify(before));
  assert(before.pager === null, "no pager in recommend mode", JSON.stringify(before));

  const picked = await cdp.eval(`(() => {
    const c = [...document.querySelectorAll('.chip-row button.chip')]
      .find(x => x.textContent.trim() && x.textContent.trim() !== '推荐');
    if (!c) return null;
    const name = c.textContent.trim();
    c.click();
    return name;
  })()`);
  assert(!!picked, "a category chip is available", String(picked));

  const switched = await cdp.eval(
    WAIT(`return document.querySelector('.chip.is-active')?.textContent?.trim() === ${JSON.stringify(picked)}
      && document.querySelector('.pager') ? 'OK' : null;`, 30000),
  );
  assert(switched === "OK", "chip switches inline and pager appears", String(switched));
  // pager 是分类态常驻的，出现不等于数据到了；再等网格/空态真正落地。
  await cdp.eval(WAIT(`return document.querySelectorAll('.vod-card').length > 0
    || (!document.querySelector('.spinner') && !!document.querySelector('.empty')) ? 'OK' : null;`, 30000));
  await sleep(400);

  const after = JSON.parse(await cdp.eval(SNAP));
  console.log(`[info] after: ${JSON.stringify(after)}`);
  assert(after.title === "首页", "still on home page (no route push)", after.title);
  assert(after.backBtn === false, "no back button (not a二级 page)", String(after.backBtn));
  assert(after.activeChip === picked, "clicked chip is highlighted", JSON.stringify(after));
  assert(after.pager !== null, "category pager rendered", JSON.stringify(after));
  assert(after.cards > 0, "grid refreshed with category content", JSON.stringify(after));

  // 回到推荐：分页条消失、网格恢复首页推荐内容。
  await cdp.eval(`(() => { const c=[...document.querySelectorAll('.chip-row .chip')].find(x=>x.textContent.trim()==='推荐'); c&&c.click(); return true; })()`);
  await sleep(700);
  const restored = JSON.parse(await cdp.eval(SNAP));
  assert(restored.activeChip === "推荐" && restored.pager === null,
    "推荐 chip restores the recommend grid", JSON.stringify(restored));
  assert(restored.cards === before.cards, "recommend list restored", JSON.stringify({ before: before.cards, after: restored.cards }));
} catch (err) {
  failures += 1;
  console.error(`[FAIL] probe crashed: ${String((err && err.stack) || err)}`);
} finally {
  cdp.close();
}
console.log(failures === 0 ? "\nPASS home inline category" : `\nFAILED ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
