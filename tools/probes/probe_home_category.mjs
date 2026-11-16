#!/usr/bin/env node
/**
 * 首页分类 chip 必须「原地换下方网格」，不能 push 二级页面。
 *
 * 断言顺序刻意放在真实窗口里：源码契约只能保证没写 navigate，但保证不了
 * 「点完 chip 页面标题还是首页、没有返回键、网格真的换了」。
 *
 * 沉浸式首页（2026-11-15）后两条 DOM 契约变了：
 *   - 推荐 tab 不再是 .vod-card 网格，而是 .home-hero 头图 + 超过 5 条时的
 *     .poster-tile 横排（HomePage.tsx 749-762、HERO_COUNT=5）；分类 tab 仍是
 *     .vod-card 网格（HomePage.tsx 736-748）。
 *   - 分页从底部「下一页」按钮（旧 CategoryPage 的 .pager）改成
 *     IntersectionObserver + .infinite-sentinel 滚动加载（HomePage.tsx 573-592、
 *     766-779）。`.pager` 在 src 的 tsx/ts/js/jsx 里已 0 命中（仅 feedback.css
 *     残留孤立样式块，没有组件再渲染这些类名）。
 * 探针同步把「分页按钮可点」改成「滚到底会拉到下一页（或显示『到底啦』tip）」，
 * 守住的是同一条不变量：分类列表能继续往后翻，而不是停在第一页。
 * 用真实配置跑，不需要桩服务；收尾点回「推荐」恢复现场。
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
  // 旧分页条 .pager/.pager__label 已从产品 DOM 移除（HomePage.tsx 766-779 改
  // 成 .infinite-foot + .infinite-sentinel），所以这里读 sentinel 而不是 pager。
  sentinel: !!document.querySelector('.infinite-sentinel'),
  hero: !!document.querySelector('.home-hero'),
  tiles: document.querySelectorAll('.poster-tile').length,
  cards: document.querySelectorAll('.vod-card').length,
  recommendChip: [...document.querySelectorAll('.chip-row .chip')].some(c => c.textContent.trim() === '推荐'),
})`;

// 「推荐 tab 上有内容」：头图（整块 1 单位）+ 横排 tile + 卡片网格任一在位。
// 与 probe_home_site 同口径，对沉浸式首页（HomePage.tsx 749-762）成立。
const hasHomeContent = (s) => Boolean(s) && ((s.hero ? 1 : 0) + (s.tiles ?? 0) + (s.cards ?? 0)) > 0;

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
  // 重载后首页数据是异步的：分类 chip 与网格都要等它落地，否则会读到空 chip-row。
  // 沉浸式首页（HomePage.tsx 749-762）：推荐 tab 用 .home-hero/.poster-tile，
  // 没有 .vod-card；分类 tab 才出 .vod-card。等待时一并算这两类节点 + .empty。
  assert(
    (await cdp.eval(WAIT(`return document.querySelector('.home-hero')
      || document.querySelectorAll('.poster-tile').length > 0
      || document.querySelectorAll('.vod-card').length > 0
      || !!document.querySelector('.empty') ? 'OK' : null;`, 30000))) === "OK",
    "home content settled",
  );
  // 确保从「推荐」起步，不被上一次运行留下的选中态影响。
  await cdp.eval(`(() => { const c=[...document.querySelectorAll('.chip-row .chip')].find(x=>x.textContent.trim()==='推荐'); c&&c.click(); return true; })()`);
  await sleep(600);

  const before = JSON.parse(await cdp.eval(SNAP));
  console.log(`[info] before: ${JSON.stringify(before)}`);
  assert(before.activeChip === "推荐", "推荐 chip is active by default", JSON.stringify(before));
  assert(before.recommendChip === true, "推荐 chip present", JSON.stringify(before));
  // 推荐 tab 应该是沉浸式（头图/横排在位 + 没有分类用的 .infinite-sentinel）。
  // 旧断言是「pager 不存在」；产品里 pager DOM 已移除、由滚动哨兵替代，
  // 等价不变量是「推荐 tab 不挂载分类用的无限滚动哨兵」。
  assert(
    before.sentinel === false && hasHomeContent(before),
    "recommend tab shows immersive content, no category sentinel",
    JSON.stringify(before),
  );

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
      && document.querySelector('.infinite-sentinel') ? 'OK' : null;`, 30000),
  );
  assert(switched === "OK", "chip switches inline and infinite-scroll sentinel mounts", String(switched));
  // sentinel 出现 ≠ 数据到位（catLoading 时只有 .sk-grid 骨架），再等网格或空态。
  await cdp.eval(WAIT(`return document.querySelectorAll('.vod-card').length > 0
    || (!document.querySelector('.sk-grid') && !!document.querySelector('.empty')) ? 'OK' : null;`, 30000));
  await sleep(400);

  const after = JSON.parse(await cdp.eval(SNAP));
  console.log(`[info] after: ${JSON.stringify(after)}`);
  assert(after.title === "首页", "still on home page (no route push)", after.title);
  assert(after.backBtn === false, "no back button (not a二级 page)", String(after.backBtn));
  assert(after.activeChip === picked, "clicked chip is highlighted", JSON.stringify(after));
  // 分类态必须挂载 .infinite-sentinel（替代旧 .pager）；沉浸式头图应让位给网格。
  assert(after.sentinel === true, "infinite-scroll sentinel mounted in category mode", JSON.stringify(after));
  assert(after.cards > 0, "grid refreshed with category content", JSON.stringify(after));

  // 分页必须真的能继续往后翻：旧 CategoryPage 用底部「下一页」按钮，
  // 现在改成 .infinite-sentinel 进视口 → loadMore → 下一页追加。
  // 验证方式：把 .page-body（产品里唯一的滚动容器，layout.css 396-404）滚到底，
  // 等到 .vod-card 数量增长（page 2 落地）或「已经到底啦」tip 出现。
  // 两个分支都接受，因为桩/真实站可能只有一页（catHasMore=false 时出 tip）；
  // 关键不变量是「滚动确实触发了下一页流程，而不是停在 page 1 死水」。
  const firstPageCards = after.cards;
  const scrolled = await cdp.eval(`(() => {
    const body = document.querySelector('.page-body');
    if (!body) return 'NO_BODY';
    const prev = body.scrollTop;
    body.scrollTop = body.scrollHeight;
    return body.scrollTop > prev ? 'SCROLLED' : 'NO_GROWTH';
  })()`);
  assert(scrolled === "SCROLLED", "page-body scrolls (sentinel becomes reachable)", String(scrolled));
  const grown = await cdp.eval(
    WAIT(`return (document.querySelectorAll('.vod-card').length > ${firstPageCards})
      || !!document.querySelector('.infinite-foot .tip') ? 'OK' : null;`, 30000),
  );
  const page2 = JSON.parse(await cdp.eval(SNAP));
  const tipText = await cdp.eval(`document.querySelector('.infinite-foot .tip')?.textContent?.trim() || null`);
  console.log(`[info] after scroll: cards=${page2.cards} tip=${tipText}`);
  assert(
    grown === "OK" && page2.title === "首页",
    "scroll-to-bottom loads page 2 inline (or marks end-of-list)",
    JSON.stringify({ firstPageCards, page2, tipText }),
  );

  // 回到推荐：分页哨兵卸载、网格恢复成沉浸式头图/横排（不再是 .vod-card）。
  await cdp.eval(`(() => { const c=[...document.querySelectorAll('.chip-row .chip')].find(x=>x.textContent.trim()==='推荐'); c&&c.click(); return true; })()`);
  await sleep(700);
  const restored = JSON.parse(await cdp.eval(SNAP));
  // 旧断言比的是 restored.pager===null && restored.cards===before.cards（0==0 平凡通过）。
  // 新断言要守住「推荐 tab 真的回到推荐视图」：activeChip 是「推荐」、分类用的
  // .infinite-sentinel 卸载、推荐用的沉浸式节点（hero/tiles）恢复，与 before 一致。
  assert(
    restored.activeChip === "推荐" && restored.sentinel === false && hasHomeContent(restored),
    "推荐 chip restores the recommend view (sentinel unmounted)",
    JSON.stringify(restored),
  );
  assert(
    restored.hero === before.hero && restored.tiles === before.tiles,
    "recommend immersive layout restored",
    JSON.stringify({ before: { hero: before.hero, tiles: before.tiles }, restored: { hero: restored.hero, tiles: restored.tiles } }),
  );
} catch (err) {
  failures += 1;
  console.error(`[FAIL] probe crashed: ${String((err && err.stack) || err)}`);
} finally {
  cdp.close();
}
console.log(failures === 0 ? "\nPASS home inline category" : `\nFAILED ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
