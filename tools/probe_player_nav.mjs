#!/usr/bin/env node
/**
 * 播放页新版布局回归（2026-11-12 重构）：
 *   播放器（内含上一集/下一集 + 线路徽标） → 影片信息卡 → 选集
 *
 * 断言的是「结构 + 真实跳转」：
 *   1. 上/下一集按钮必须挂在 `.player-stage` 里面，且 `.player-about` /
 *      `.player-episodes` 依次排在播放器下方（用几何位置判断，不只看存在）；
 *   2. 点「下一集」真的换集：标题副标题与线路徽标都要变成第 2 集；
 *   3. 选集常驻，不需要任何按钮展开。
 *
 * 依赖：dev 窗口（CDP 9222）。  node tools/probe_player_nav.mjs
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
      const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 60000);
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
      const page = pages.find((t) => t.url.startsWith("http://localhost:1420")) ?? pages[0];
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("dev window (CDP 9222) not found");
}

const WAIT = (expression, timeout = 30000) => `(async () => {
  const deadline = Date.now() + ${timeout};
  while (Date.now() < deadline) {
    const value = (() => { ${expression} })();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");

try {
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000))) === "OK",
    "app rendered",
  );

  // 历史里一定有可播条目：借道进详情再进播放页。
  await cdp.eval(`[...document.querySelectorAll('.nav__item')].find((b) => b.textContent.includes('历史'))?.click()`);
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.fav-item .vod-card') ? 'OK' : null;", 25000))) === "OK",
    "history page has cards",
  );

  let entered = false;
  for (let attempt = 0; attempt < 5 && !entered; attempt += 1) {
    const opened = await cdp.eval(`(() => {
      const card = document.querySelectorAll('.fav-item .vod-card')[${attempt}];
      if (!card) return 'MISSING';
      card.click();
      return 'CLICKED';
    })()`);
    if (opened !== "CLICKED") break;
    await cdp.eval(WAIT("return document.querySelector('.episode, .error-bar, .detail-title') ? 'OK' : null;", 20000));
    const played = await cdp.eval(`(() => {
      const btn = document.querySelector('.episode');
      if (!btn) return 'NONE';
      btn.click();
      return 'CLICKED';
    })()`);
    if (played === "CLICKED") {
      entered = true;
      break;
    }
    await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('.page-head button')].find((n) =>
        ((n.getAttribute('aria-label') || '') + (n.textContent || '')).includes('返回'),
      );
      if (btn) btn.click();
    })()`);
    await sleep(1200);
  }
  assert(entered, "opened a playable detail from history");

  assert(
    (await cdp.eval(WAIT("return document.querySelector('.page--player') ? 'OK' : null;", 20000))) === "OK",
    "player page mounted",
  );

  // 剧集列表是异步拉的：等徽标出现，说明 lines/currentLine 就绪。
  const badge = await cdp.eval(
    WAIT("return document.querySelector('.player-stage__badge')?.textContent?.trim() || null;", 25000),
  );
  assert(!!badge && /第 1 \/ \d+ 集/.test(badge), "player stage badge shows line + episode", String(badge));

  const layout = await cdp.eval(`(() => {
    const stage = document.querySelector('.player-stage');
    const about = document.querySelector('.player-about');
    const episodes = document.querySelector('.player-episodes');
    if (!stage || !about || !episodes) return JSON.stringify({ stage: !!stage, about: !!about, episodes: !!episodes });
    const prev = stage.querySelector('.player-nav--prev');
    const next = stage.querySelector('.player-nav--next');
    const rect = (el) => el.getBoundingClientRect();
    return JSON.stringify({
      navInStage: !!prev && !!next,
      aboutBelowStage: Math.round(rect(about).top) >= Math.round(rect(stage).bottom) - 2,
      episodesBelowAbout: Math.round(rect(episodes).top) >= Math.round(rect(about).bottom) - 2,
      episodeCount: episodes.querySelectorAll('.episode').length,
      activeCount: episodes.querySelectorAll('.episode.is-active').length,
      hasSelectToggle: !![...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '选集'),
    });
  })()`);
  const info = JSON.parse(layout || "{}");
  assert(info.navInStage === true, "上一集/下一集在播放器内部", layout);
  assert(info.aboutBelowStage === true, "影片信息卡在播放器下方", layout);
  assert(info.episodesBelowAbout === true, "选集在信息卡下方", layout);
  assert((info.episodeCount ?? 0) > 0, "选集常驻，无需展开", layout);
  assert(info.activeCount >= 1, "当前集高亮", layout);
  assert(info.hasSelectToggle === false, "旧的「选集」按钮已移除", layout);

  // 点播放器里的「下一集」：标题副标题 + 徽标都要变成第 2 集。
  const advanced = await cdp.eval(`(() => {
    const btn = document.querySelector('.player-stage .player-nav--next');
    if (!btn || btn.disabled) return 'MISSING';
    btn.click();
    return 'CLICKED';
  })()`);
  assert(advanced === "CLICKED", "click 下一集 inside the player", String(advanced));
  if (advanced === "CLICKED") {
    const after = await cdp.eval(
      WAIT(
        "const sub = document.querySelector('.page-title__sub')?.textContent?.trim() || ''; return sub.includes('2') ? sub : null;",
        25000,
      ),
    );
    assert(!!after, "title subtitle switched to episode 2", String(after));
    // 应用走内部路由状态（不改 location.hash），用信息卡上的「线路 · 集名」判断换集生效。
    // 集名不一定是「第 N 集」（采集源常见「第 N 期 / 第 N 话」），所以比对副标题里的
    // 实际集名，而不是写死「第 2 集」的正则——否则换个源就假红。
    const aboutNow = await cdp.eval(
      WAIT(
        `const el = document.querySelector('.player-about__now');
         const t = el ? el.textContent.trim() : '';
         return t && t.includes(${JSON.stringify(String(after))}) ? t : null;`,
        20000,
      ),
    );
    assert(!!aboutNow, "about card follows the new episode", String(aboutNow));
    const badgeAfter = await cdp.eval(
      WAIT("return document.querySelector('.player-stage__badge')?.textContent?.trim() || null;", 25000),
    );
    assert(/第 2 \//.test(String(badgeAfter)), "badge follows the new episode", String(badgeAfter));
  }

  assert(cdp.errors.length === 0, "no uncaught exceptions", cdp.errors.join(" | ").slice(0, 400));
} catch (err) {
  failures += 1;
  console.error(`[FAIL] probe crashed: ${err && err.message ? err.message : err}`);
} finally {
  cdp.close();
}

console.log(failures === 0 ? "\nPASS player layout" : `\nFAILED ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
