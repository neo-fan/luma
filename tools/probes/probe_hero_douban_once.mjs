#!/usr/bin/env node
/**
 * 首页头图的豆瓣到货一次性回归。
 *
 * 钉住两件事：
 *   1. 封面与评分/简介**同一批**变成豆瓣态——此前头图读中间态，`cover` 相先把 meta
 *      行改写一次，`full` 相再补评分与简介，同屏文字连跳两次很突兀；
 *   2. 源站海报 → 豆瓣海报走交叉淡入（淡入期间两层都有图），不是就地硬切。
 *
 * 采样从冷 reload 起：store 是进程内的，若豆瓣已命中终态，头图一次就画成豆瓣态，
 * 没有可比的两段 —— 那种情况报 SKIP，不假装通过。采样期间把焦点落进头图，借
 * 组件已有的「聚焦暂停轮播」稳住这一屏（豆瓣偶尔比 6.5s 的自动轮播慢）。
 * 淡入只在源站海报真画出来时判定；推荐位由豆瓣驱动、`vod_pic` 为空时没有可淡入的
 * 前态，打一行 info 说明，不算验过。
 *
 * 依赖 dev 窗口（CDP 9222）。  node tools/probes/probe_hero_douban_once.mjs
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

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PREFS_KEY = "luma:douban:prefs";

/** 页面内采样器：每 50ms 记一次头图可见状态，豆瓣落定或换片即停。 */
const SAMPLER = `(() => {
  const probe = { samples: [], done: false, reason: "", firstTitle: "", afterLand: 0 };
  window.__heroProbe = probe;
  const t0 = Date.now();
  const timer = setInterval(() => {
    const poster = document.querySelector('.home-hero__poster');
    const title = document.querySelector('.home-hero__title');
    const meta = document.querySelector('.home-hero__meta');
    const intro = document.querySelector('.home-hero__intro');
    const imgs = poster ? [...poster.querySelectorAll('img')] : [];
    const rec = {
      t: Date.now() - t0,
      title: title ? title.textContent.trim() : '',
      origin: poster ? poster.getAttribute('data-origin') || '' : '',
      srcs: imgs.map((img) => img.getAttribute('src') || ''),
      meta: meta ? meta.textContent.trim() : '',
      intro: intro ? intro.textContent.trim().slice(0, 36) : '',
      reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
    probe.samples.push(rec);

    if (!probe.firstTitle && rec.title) probe.firstTitle = rec.title;
    const landed = rec.origin === "douban" && rec.meta.includes('★');
    if (probe.firstTitle && rec.title !== probe.firstTitle) {
      probe.done = true;
      probe.reason = 'rotation';
      clearInterval(timer);
    } else if (landed) {
      // 再多采几帧，交叉淡入期间两层是同时有图的。
      probe.afterLand += 1;
      if (probe.afterLand > 8) {
        probe.done = true;
        probe.reason = 'landed';
        clearInterval(timer);
      }
    } else if (Date.now() - t0 > 30000) {
      probe.done = true;
      probe.reason = 'timeout';
      clearInterval(timer);
    }
  }, 50);
  return true;
})()`;

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
console.log(`target: ${page.url}`);

try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  // 豆瓣必须开着；记下原值，跑完还原。
  const originalPrefs = await cdp.eval(
    `(() => localStorage.getItem(${JSON.stringify(PREFS_KEY)}))()`
  );
  await cdp.eval(
    `(() => localStorage.setItem(${JSON.stringify(PREFS_KEY)}, ${JSON.stringify(
      JSON.stringify({ enabled: true, proxyType: "direct", proxyPrefix: "" })
    )}))()`
  );

  await cdp.eval(`location.hash = '#/'`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1200);
  await cdp.eval(SAMPLER);

  // 豆瓣偶尔比 6.5s 的自动轮播慢，一换片就没有可比对象了。头图在「键盘聚焦在区内」
  // 时暂停轮播（onFocusCapture），这是用户本来就有的行为，探针借用它把这一屏稳住。
  const paused = await cdp.eval(`(async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const btn = document.querySelector('.home-hero__actions button');
      if (btn) {
        btn.focus();
        return 'FOCUSED';
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return 'MISSING';
  })()`);
  console.log(`[info] 轮播暂停: ${paused}`);

  let probe = null;
  const readDeadline = Date.now() + 45000;
  while (Date.now() < readDeadline) {
    const raw = await cdp.eval(
      `(() => (window.__heroProbe && window.__heroProbe.done ? JSON.stringify(window.__heroProbe) : null))()`
    );
    if (raw) {
      probe = JSON.parse(raw);
      break;
    }
    await sleep(1000);
  }
  if (!probe) {
    console.log("[FAIL] 采样器没有收尾");
    failures += 1;
  } else {
    console.log(`[info] 采样 ${probe.samples.length} 帧，收尾原因: ${probe.reason}`);

    const isDouban = (rec) => rec.origin === "douban";
    const hasStar = (rec) => rec.meta.includes("★");
    const painted = (rec) => rec.srcs.some((src) => src.length > 0);
    const stateKey = (rec) => `${rec.origin}|${rec.srcs.join("|")}#${rec.meta}#${rec.intro}`;

    const states = [];
    probe.samples.forEach((rec, index) => {
      const key = stateKey(rec);
      if (!states.length || states[states.length - 1].key !== key) {
        states.push({ key, rec, index });
      }
    });

    // 判据用组件自己声明的来源（`data-origin`）：源站海报本身就可能挂在豆瓣域名上，
    // 拿 URL 里有没有 douban 当「换过封面」，会从一开始就判成豆瓣态，下面的断言全空过。
    const sourceIdx = states.findIndex((s) => s.rec.origin === "source");
    const sourcePaintedIdx = states.findIndex((s) => s.rec.origin === "source" && painted(s.rec));
    const doubanIdx = states.findIndex((s) => isDouban(s.rec));
    const starIdx = states.findIndex((s) => hasStar(s.rec));
    console.log(
      `[info] 状态数 ${states.length}；源站来源 @${sourceIdx}（其中真画出图的最早 @${sourcePaintedIdx}），豆瓣海报 @${doubanIdx}，★ @${starIdx}`
    );

    if (!probe.samples.some((rec) => rec.title)) {
      console.log("[SKIP] 头图始终没渲染（首页没出内容 / 站点不可达），无可判定对象");
    } else if (sourceIdx < 0 || doubanIdx < 0 || starIdx < 0 || doubanIdx < sourceIdx) {
      // 没有「先是源站来源、后换豆瓣」这两段可比状态就没法判定：豆瓣无匹配、
      // 已命中缓存一次到位、或采样起跑太晚。属环境状态，报 SKIP 而不是放宽断言蒙过。
      console.log(
        `[SKIP] 缺少可比的两段（源站 @${sourceIdx} / 豆瓣 @${doubanIdx} / ★ @${starIdx}，原因 ${probe.reason}）`
      );
    } else {
      assert(
        doubanIdx === starIdx,
        "封面与评分在同一批到货（没有先跳文字）",
        `poster@${doubanIdx} star@${starIdx}`
      );

      const after = states.slice(doubanIdx + 1);
      const regress = after.filter((s) => !isDouban(s.rec) || !hasStar(s.rec));
      assert(
        regress.length === 0,
        "到货后头图不再回退第二次",
        `${after.length} 帧里有 ${regress.length} 次回退`
      );

      const firstIntro = states[doubanIdx].rec.intro;
      const introChangedLater = after.some((s) => s.rec.intro !== firstIntro);
      assert(!introChangedLater, "简介没有第二次替换", String(introChangedLater));

      if (probe.samples[0]?.reduced === true) {
        console.log("[info] 系统要求减弱动效，跳过淡入判定");
      } else if (sourcePaintedIdx < 0) {
        // 源站海报这一屏根本没画出来（推荐位由豆瓣驱动、vod_pic 为空），
        // 没有「从源站海报淡入到豆瓣海报」这回事；只说明情况，不假装验过。
        console.log("[info] 源站海报未画出，跳过淡入判定");
      } else {
        // 淡入窗口按「原始帧序号」取：states 的下标是压缩后的，直接拿去切 samples
        // 会落到启动期的空帧上。
        const landAt = states[doubanIdx].index;
        const fadeWindow = probe.samples.slice(Math.max(0, landAt - 3), landAt + 9);
        const bothLayers = fadeWindow.some(
          (rec) => rec.srcs.filter((src) => src.length > 0).length === 2
        );
        assert(
          bothLayers,
          "海报替换走交叉淡入（两层同时有图）",
          JSON.stringify(fadeWindow.map((rec) => [rec.origin, rec.srcs.map((src) => src.length)]))
        );
      }
    }
  }

  if (originalPrefs === null || originalPrefs === undefined) {
    await cdp.eval(`(() => localStorage.removeItem(${JSON.stringify(PREFS_KEY)}))()`);
  } else {
    await cdp.eval(
      `(() => localStorage.setItem(${JSON.stringify(PREFS_KEY)}, ${JSON.stringify(originalPrefs)}))()`
    );
  }
  await cdp.eval(`location.hash = '#/'`);

  assert(cdp.errors.length === 0, "no uncaught page exceptions", cdp.errors.slice(0, 3).join(" | ").slice(0, 600));
} catch (err) {
  console.log(`[diag] unexpected error: ${String((err && err.stack) || err)}`);
  failures += 1;
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed step(s)`);
cdp.close();
process.exit(failures === 0 ? 0 : 1);
