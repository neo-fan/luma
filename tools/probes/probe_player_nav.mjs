#!/usr/bin/env node
/**
 * 播放页布局回归（2026-11-14 更新）：
 *   播放器（控制栏内含下一集 / 刷新） → 影片信息卡 → 常驻选集
 *
 * 断言的是「结构 + 真实跳转」：
 *   1. 下一集 / 刷新是 ArtPlayer 原生控制栏控件，下一集紧挨暂停右侧；
 *      上一集浮层与器内徽标已彻底移除，`.player-about` / `.player-episodes`
 *      依次排在播放器下方（用几何位置判断，不只看存在）；
 *   2. 点控制栏「下一集」真的换集：标题副标题与选集高亮跟着变；
 *   3. 选集常驻，不需要任何按钮展开。
 *
 * 依赖：dev 窗口（CDP 9222）。  node tools/probes/probe_player_nav.mjs
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

  // 剧集列表是异步拉的：等选集面板出现，说明 lines/currentLine 就绪。
  const episodesReady = await cdp.eval(
    WAIT("return document.querySelectorAll('.player-episodes .episode').length > 0 ? 'OK' : null;", 25000),
  );
  assert(episodesReady === 'OK', 'episode list ready', String(episodesReady));

  const LAYOUT = `(() => {
    const stage = document.querySelector('.player-stage');
    const about = document.querySelector('.player-about');
    const episodes = document.querySelector('.player-episodes');
    if (!stage || !about || !episodes) return JSON.stringify({ stage: !!stage, about: !!about, episodes: !!episodes });
    const next = stage.querySelector('.art-control-next-episode[aria-label="下一集"]');
    const reload = stage.querySelector('.art-control-reload[aria-label="刷新播放"]');
    const play = stage.querySelector('.art-control-playAndPause');
    const rect = (el) => el.getBoundingClientRect();
    // 下一集必须紧挨播放/暂停右侧，刷新紧随其后；上一集浮层已彻底删除。
    const nextRightOfPlay = !!next && !!play && rect(next).left >= rect(play).right - 2;
    const reloadRightOfNext = !!reload && !!next && rect(reload).left >= rect(next).right - 2;
    return JSON.stringify({
      nextInControls: !!next,
      reloadInControls: !!reload,
      noPrevButton: !stage.querySelector('.player-nav--prev'),
      noOldNav: stage.querySelectorAll('.player-nav').length === 0,
      nextRightOfPlay,
      reloadRightOfNext,
      aboutBelowStage: Math.round(rect(about).top) >= Math.round(rect(stage).bottom) - 2,
      episodesBelowAbout: Math.round(rect(episodes).top) >= Math.round(rect(about).bottom) - 2,
      episodeCount: episodes.querySelectorAll('.episode').length,
      activeCount: episodes.querySelectorAll('.episode.is-active').length,
      hasSelectToggle: !![...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '选集'),
    });
  })()`;

  // 「下一集 / 刷新」是 ArtPlayer 在播放实例建好且 episodeNav 就绪后才 push 进 controls 的
  // （src/hooks/usePlayerEngine.ts:340/370）。源解析普遍要数秒~十几秒，单帧采样会读到还没挂好的
  // 控制条（nextInControls:false，2026-11-16 套件里就是这样 24s 假红）。带超时轮询、每拍先
  // mouseMoved 唤出可能自动隐藏的控制条再读几何；超时后必须分流：
  //   · 视频真在播却仍没有按钮 = 真回归，保留 FAIL（不放宽）；
  //   · 真实点播源根本没解出画面 = 网络/源站限制，如实 [SKIP] 归环境。
  // （分流写法对齐已实现的 probe_episode_switch.mjs。）
  const revealControls = async () => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 360, buttons: 0 }).catch(() => {});
    await sleep(300);
  };
  let info = null;
  const ctrlDeadline = Date.now() + 45000;
  while (Date.now() < ctrlDeadline) {
    await revealControls();
    info = JSON.parse((await cdp.eval(LAYOUT)) || "{}");
    if (info.nextInControls && info.reloadInControls) break;
  }

  const playerState = JSON.parse(
    (await cdp.eval(`(() => {
      const v = document.querySelector('.player-art video') || document.querySelector('video');
      const playing = !!v && ((v.currentSrc || v.src) && (v.currentTime > 0 || v.readyState >= 2));
      return JSON.stringify({
        hasVideo: !!v,
        playing: !!playing,
        t: v ? Number((v.currentTime || 0).toFixed(1)) : null,
        rs: v ? v.readyState : null,
        src: v ? (v.currentSrc || v.src || '').slice(0, 18) : '',
        err: document.querySelector('.error-bar__text')?.textContent?.trim().slice(0, 40) || null,
      });
    })()`)) || "{}",
  );

  // 结构类断言只依赖应用渲染的 .player-about / .player-episodes，与播放实例无关，始终校验。
  assert(info.noPrevButton === true && info.noOldNav === true, "旧的上一集浮层已删除", JSON.stringify(info));
  assert(info.aboutBelowStage === true, "影片信息卡在播放器下方", JSON.stringify(info));
  assert(info.episodesBelowAbout === true, "选集在信息卡下方", JSON.stringify(info));
  assert((info.episodeCount ?? 0) > 0, "选集常驻，无需展开", JSON.stringify(info));
  assert(info.activeCount >= 1, "当前集高亮", JSON.stringify(info));
  assert(info.hasSelectToggle === false, "旧的「选集」按钮已移除", JSON.stringify(info));

  const controlsMissing = !info.nextInControls || !info.reloadInControls;
  if (controlsMissing && !playerState.playing) {
    // 没出画 → 控制项没机会挂载，属环境（真实点播源不可用），不算产品回归。
    console.log(
      `[SKIP] 控制项未挂载：真实点播源未出画（hasVideo=${playerState.hasVideo} playing=${playerState.playing} ` +
        `src=${playerState.src || "-"} err=${playerState.err || "-"}），属网络/源站限制非产品回归`,
    );
    assert(cdp.errors.length === 0, "no uncaught exceptions", cdp.errors.join(" | ").slice(0, 400));
  } else {
    // 控制项已挂载（正常），或在播却没挂载（真回归）——两种都要断言，不许因为「轮询到超时」就放行。
    assert(info.nextInControls === true, "下一集在控制栏里", `${JSON.stringify(info)} player=${JSON.stringify(playerState)}`);
    assert(info.reloadInControls === true, "刷新在控制栏里", `${JSON.stringify(info)} player=${JSON.stringify(playerState)}`);
    assert(info.nextRightOfPlay === true, "下一集紧挨暂停右侧", JSON.stringify(info));
    assert(info.reloadRightOfNext === true, "刷新紧随下一集", JSON.stringify(info));

    // 点播放器里的「下一集」：标题副标题 + 徽标都要变成第 2 集。
    if (info.nextInControls) {
      const advanced = await cdp.eval(`(() => {
        const btn = document.querySelector('.art-control-next-episode[aria-label="下一集"]');
        if (!btn || btn.getAttribute('aria-disabled') === 'true') return 'MISSING';
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
        const activeAfter = await cdp.eval(
          WAIT("return document.querySelector('.player-episodes .episode.is-active')?.textContent?.trim() || null;", 25000),
        );
        assert(!!activeAfter, "episode panel highlights the new episode", String(activeAfter));
      }
    } else {
      // 视频确实在播却没有「下一集」控制项 → 真回归，保留 FAIL 不写成 SKIP。
      assert(false, "click 下一集 inside the player",
        `视频在播(${playerState.t}s/rs${playerState.rs})却没有可点的「下一集」控制项 -- ${JSON.stringify(playerState)}`);
    }
    assert(cdp.errors.length === 0, "no uncaught exceptions", cdp.errors.join(" | ").slice(0, 400));
  }

} catch (err) {
  failures += 1;
  console.error(`[FAIL] probe crashed: ${err && err.message ? err.message : err}`);
} finally {
  cdp.close();
}

console.log(failures === 0 ? "\nPASS player layout" : `\nFAILED ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
