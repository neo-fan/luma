#!/usr/bin/env node
/**
 * 播放会话状态机 ↔ 现实行为的一致性（2.0.0 内核解释器化的回归网）。
 *
 * 为什么需要它：判决的真源已经从解释器迁进 `vodSessionMachine`（会话身份 / 首帧 /
 * unknown 累计 / 判死交棒都由 actor 说话）。node 下的机器测试只能证明**模型自洽**，
 * 证明不了「引擎真的把事件喂对了」。影子阶段靠一次性脚本人工比对，从这一步起
 * 改成常驻探针：真实点播 + 真实换集，逐条钉不变量。
 *
 * 换集有两条合法路径，探针都接受、分别断言（2026-11-16 实测：同一部片不同轮次会
 * 各走一条，取决于 `resolve_play` 这轮给不给得出地址）：
 *   A. 原地换集 —— 同一个 actor：必须出现 `switching`，收口后 `sessionId` 自增 1；
 *   B. 退回整页重建（`线路不可解析` / 播放类型变化）—— actor 新建：`instance` 变、
 *      `sessionId` 从 1 重来，这条**不是**回归。
 *
 * 判定口径（重要）：
 *   - 真实点播源不可用 / 没出画 → **SKIP**（exit 0，环境依赖，不是回归）；
 *   - 出画后机器状态与现实不符（没进 playing、hasPlayed 没置位、健康播放中被误判
 *     probing/recovering、unknown 计数非 0、原地换集不进 switching 或不收口）→ **FAIL**；
 *   - 交棒链断了（注入坏源后既不进 recovering 也没有判死红条，或 30s 没人接手）→ **FAIL**。
 *
 * 依赖 dev 窗口（CDP 9222）、真实配置与外网。关键词可用 LUMA_KEYWORD 覆盖。
 *
 *   node tools/probes/probe_session_machine.mjs
 */
import { connect, finish } from "./lib/cdp.mjs";

const keyword = process.env.LUMA_KEYWORD || "庆余年";
const cdp = await connect();
const problems = [];

const SESSION = `(() => {
  const s = window.__lumaPlayerSession;
  const v = document.querySelector('.player-art video') || document.querySelector('video');
  return {
    instance: s ? s.instance : null,
    state: s ? s.value : null,
    ctx: s ? s.context : null,
    hash: location.hash,
    videoSrc: v ? String(v.currentSrc || '').slice(-14) : null,
    readyState: v ? v.readyState : -1,
    width: v ? v.videoWidth : 0,
    currentTime: v ? Number(v.currentTime.toFixed(2)) : -1,
  };
})()`;

/** 轮询到条件成立为止；单点采样对秒级的解析 / 出画过程一律不可信。 */
async function until(expression, predicate, timeoutMs, everyMs = 700) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.eval(expression);
    if (last && predicate(last)) return { ok: true, value: last };
    await cdp.sleep(everyMs);
  }
  return { ok: false, value: last };
}

/** 点「下一集」按钮：控制条会自动隐藏，每拍先 mouseMoved 唤出再按 rect 中心真点。 */
async function clickNextEpisode(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: 420, buttons: 0 });
    await cdp.sleep(400);
    const target = await cdp.eval(`(() => {
      const node = [...document.querySelectorAll('.art-controls .art-control, .art-control')]
        .find((item) => /下一集|next/i.test((item.getAttribute('aria-label') || '') + (item.getAttribute('title') || '')));
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
    })()`);
    if (target) {
      await cdp.click(target.x, target.y);
      return true;
    }
  }
  return false;
}

// 1) 搜索 → 详情 → 播放。真实源的成功率是抽签级的（2026-11-16 实测：同一个关键词
// 两次分别命中能播的 py_pianku4k 和根本不出画的 py_奇优动漫），所以依次试前几张
// 卡片，直到有一张真出画为止；全都失败才是环境 SKIP。
await cdp.eval("location.hash = '#/search'");
await cdp.sleep(1200);
const submitted = await cdp.eval(`(() => {
  const input = document.querySelector('.content input.input');
  if (!input) return 'no-input';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(keyword)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.closest('form')?.requestSubmit();
  return 'submitted';
})()`);
if (submitted !== "submitted") {
  console.log(`[SKIP] 搜索框不可用（${submitted}），本探针需要真实配置与可搜的源`);
  cdp.close();
  process.exit(0);
}
const cardCount = async () => cdp.eval("document.querySelectorAll('.content .vod-card').length");
let attempts = 0;
for (let deadline = Date.now() + 20000; Date.now() < deadline && (await cardCount()) === 0; ) {
  await cdp.sleep(800);
}
const total = await cardCount();
if (total === 0) {
  console.log("[SKIP] 搜索没有结果卡片（网络或配置问题），无法验证状态机");
  cdp.close();
  process.exit(0);
}
let first = null;
for (let pick = 0; pick < Math.min(3, total); pick += 1) {
  attempts += 1;
  const opened = await cdp.eval(`(() => {
    const card = document.querySelectorAll('.content .vod-card')[${pick}];
    if (!card) return null;
    card.click();
    return card.getAttribute('title');
  })()`);
  if (!opened) {
    continue;
  }
  const entered = await cdp.eval(`(async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const play = [...document.querySelectorAll('.content button')].find((node) => /^播放/.test(node.textContent.trim()));
      if (play) { play.click(); return 'play-button'; }
      const episode = document.querySelector('.content .episode');
      if (episode) { episode.click(); return 'episode'; }
      await new Promise((r) => setTimeout(r, 800));
    }
    return null;
  })()`);
  if (!entered) {
    console.log(`  第 ${pick + 1} 张「${opened}」详情页没有可点入口，换下一张`);
    await cdp.eval("location.hash = '#/search'");
    await cdp.sleep(2500);
    continue;
  }
  // 等真正出画：这是机器该进 playing / 置 hasPlayed 的时刻
  const played = await until(SESSION, (s) => s.readyState >= 2 && s.width > 0, 45000, 1000);
  if (!played.ok) {
    console.log(`  第 ${pick + 1} 张「${opened}」45s 内没出画（源侧），换下一张`);
    await cdp.eval("location.hash = '#/search'");
    await cdp.sleep(2500);
    continue;
  }
  first = played.value;
  console.log(`出画（第 ${pick + 1} 张「${opened}」）:`, JSON.stringify({ instance: first.instance, state: first.state, ctx: first.ctx }));
  break;
}
if (!first) {
  console.log(`[SKIP] 试了 ${attempts} 张结果卡片都没出画，源侧/网络环境不可用`);
  cdp.close();
  process.exit(0);
}
if (first.instance == null) problems.push("dev 观测点 window.__lumaPlayerSession 不在（机器没接线或被生产构建剥掉）");
if (!first.hash.startsWith("#/player")) problems.push(`没进播放页：${first.hash}`);
if (first.state !== "playing") problems.push(`出画后机器状态应为 playing，实际 ${first.state}`);
if (first.ctx?.hasPlayed !== true) problems.push("出画后 actor.hasPlayed 仍为 false（首帧真源没接管）");
if (!(first.ctx?.sessionId >= 1)) problems.push(`actor.sessionId 应 ≥1，实际 ${first.ctx?.sessionId}`);
if (first.ctx?.unresponsiveProbes !== 0) {
  problems.push(`健康出画的会话不该有 unknown 累计，实际 ${first.ctx?.unresponsiveProbes}`);
}

// 3) 正常播放 12s：看门狗不该介入（FRAG_GROWTH 在复位，STALL 不该触发）
const healthy = await cdp.eval(`(async () => {
  const seen = [];
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = window.__lumaPlayerSession;
    seen.push(s ? [s.value, s.context.unresponsiveProbes, s.context.hasPlayed] : null);
  }
  return seen;
})()`);
const bad = healthy.filter((row) => !row || row[0] === "recovering" || row[0] === "probing" || row[1] !== 0 || row[2] !== true);
if (bad.length > 0) {
  problems.push(`播放中机器状态异常 ${bad.length}/12 拍：${JSON.stringify(bad.slice(0, 4))}`);
}
console.log("健康播放 12 拍:", JSON.stringify(healthy.slice(0, 3)), "...");

// 4) 真实换集：两条合法路径分别断言
let chainReady = false;
const pre = await cdp.eval(SESSION);
const clicked = await clickNextEpisode(30000);
if (!clicked) {
  console.log("[SKIP] 拿不到「下一集」按钮（可能是单集片源），只验了首播链路");
} else {
  let sawSwitching = false;
  let stuckAt = null;
  const deadline = Date.now() + 70000;
  let outcome = null;
  while (Date.now() < deadline && !outcome) {
    const s = await cdp.eval(SESSION);
    if (s.instance === pre.instance && s.state === "switching") {
      sawSwitching = true;
    }
    if (s.state === "recovering") {
      problems.push("换集过程中机器进了 recovering：切换期的等待被看门狗判死了");
      break;
    }
    const urlChanged = s.ctx?.targetUrl && s.ctx.targetUrl !== pre.ctx?.targetUrl;
    if (urlChanged && s.readyState >= 2 && s.width > 0) {
      outcome = s;
      break;
    }
    // 「切换中」必须有尽头：机器侧有 15s 兜底超时，真卡住说明漏了退出事件。
    if (s.state === "switching" && !stuckAt) {
      stuckAt = Date.now();
    } else if (s.state !== "switching") {
      stuckAt = null;
    }
    if (stuckAt && Date.now() - stuckAt > 20000) {
      problems.push("机器卡在 switching 超过 20s（15s 兜底超时没生效）");
      break;
    }
    await cdp.sleep(300);
  }
  if (!outcome) {
    if (problems.length === 0) {
      console.log(`[SKIP] 70s 内新集没出画（${JSON.stringify(await cdp.eval(SESSION))}），源侧环境问题`);
    }
  } else if (outcome.instance !== pre.instance) {
    chainReady = true;
    console.log("换集走的是退回整页重建（新 actor）:", JSON.stringify({ instance: outcome.instance, ctx: outcome.ctx }));
    if (outcome.state !== "playing") problems.push(`重建后机器应回到 playing，实际 ${outcome.state}`);
    if (outcome.ctx?.hasPlayed !== true) problems.push("重建后 hasPlayed 没置位（LOAD/MEDIA_ALIVE 没喂到）");
    if (outcome.ctx?.unresponsiveProbes !== 0) problems.push("重建后 unknown 计数非 0（bumpSession 没复位）");
  } else {
    chainReady = true;
    console.log("换集走的是原地切换（同一 actor）:", JSON.stringify({ ctx: outcome.ctx }));
    if (!sawSwitching) problems.push("原地换集期间没观测到 switching 状态（USER_SWITCH 没喂进机器）");
    if (outcome.ctx?.sessionId !== pre.ctx.sessionId + 1) {
      problems.push(`原地换集 sessionId 应 ${pre.ctx.sessionId + 1}，实际 ${outcome.ctx?.sessionId}`);
    }
    if (outcome.ctx?.hasPlayed !== true) problems.push("原地换集收口后 hasPlayed 没回到 true");
    if (outcome.ctx?.unresponsiveProbes !== 0) problems.push("原地换集后 unknown 计数没被 bumpSession 复位");
  }
}

// 5) 交棒链实测：2.0.0 起「撤海报 / 挂红条 / 交棒换线」不再由各调用点手写，
//    而是机器进入 recovering 时回调解释器唯一的实现。这条断言整条链真的通：
//    对正在播的 <video> 塞一个坏 src → 触发 error → 引擎报 FAILED → 机器进
//    recovering → 错误条出现判死文案 → 上层换线/换源接管（会话身份变化）。
if (chainReady) {
  const before = await cdp.eval(SESSION);
  const forced = await cdp.eval(`(() => {
    const v = document.querySelector('.player-art video') || document.querySelector('video');
    if (!v) return 'no-video';
    v.src = 'data:video/mp4;base64,AAAA';
    v.load();
    return 'forced';
  })()`);
  if (forced !== "forced") {
    problems.push(`无法注入坏源：${forced}`);
  } else {
    const seen = await until(
      `(() => {
        const s = window.__lumaPlayerSession;
        const bar = document.querySelector('.error-bar__text');
        return {
          state: s ? s.value : null,
          instance: s ? s.instance : null,
          sessionId: s ? (s.context && s.context.sessionId) : null,
          cause: s ? (s.context && s.context.failoverCause) : null,
          bar: bar ? bar.textContent.trim() : null,
        };
      })()`,
      // 交棒是同步发生的（XState 在 send 里执行 action），所以 recovering 与红条
      // 谁先被采样到都算链通；两者都没抓到才算断链。
      (r) => r.state === "recovering" || r.cause === "mediaDecode" || (r.bar || "").includes("播放器加载失败"),
      8000,
      150,
    );
    console.log("交棒链:", JSON.stringify(seen.value));
    if (!seen.ok) {
      problems.push(`注入坏源后 8s 内既没进 recovering、也没有判死红条：${JSON.stringify(seen.value)}`);
    }
    // 交棒之后必须有人接管：换线 / 换源会开新一轮（重建实例 → instance 变，
    // 或同实例重新 LOAD → ctx.sessionId 变）。卡死在 recovering 说明机器发起了
    // 但上层没接住。注意 `SESSION` 的 sessionId 在 ctx 里，别拿顶层字段比 ——
    // 那样恒为 undefined，断言会假绿（2026-11-17 第一次写就踩了这个）。
    const preInstance = before.instance;
    const preSession = before.ctx?.sessionId;
    let stuckSince = Date.now();
    let handed = { ok: false, value: null };
    const chainDeadline = Date.now() + 30000;
    while (Date.now() < chainDeadline) {
      const r = await cdp.eval(SESSION);
      if (r.state !== "recovering") {
        stuckSince = Date.now();
      }
      if (r.instance !== preInstance || r.ctx?.sessionId !== preSession) {
        handed = { ok: true, value: r };
        break;
      }
      if (Date.now() - stuckSince > 20000) {
        problems.push(`交棒后机器卡在 recovering 超过 20s，上层没有接住：${JSON.stringify(r.ctx)}`);
        break;
      }
      await cdp.sleep(400);
    }
    if (!handed.ok && problems.length === 0) {
      problems.push("交棒后 30s 内没有新会话接手（既没重建实例也没自增 sessionId）");
    } else if (handed.ok) {
      console.log(
        "新会话:",
        JSON.stringify({ state: handed.value.state, instance: handed.value.instance, sessionId: handed.value.ctx?.sessionId }),
      );
    }
  }
} else {
  console.log("（没走到原地换集，跳过交棒链实测）");
}

if (cdp.exceptions.length > 0) {
  problems.push(`页面异常：${JSON.stringify(cdp.exceptions.slice(0, 2))}`);
}

// 探针卫生：把播放页留在后台会污染后续探针，导航 + reload 归位。
await cdp.eval("location.hash = '#/';");
await cdp.eval("location.reload();");
const code = finish(problems);
cdp.close();
process.exit(code);
