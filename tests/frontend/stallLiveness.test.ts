/**
 * 卡顿看门狗的「慢 ≠ 死」契约。
 *
 * 这一层不跑真实视频（jsdom 没有 MSE），所以按源码文本钉住几条不能丢的判据：
 *
 * 1. `unknown` 要累计到阈值才换线，不能一次探活失败就跳；
 * 2. 暂停不参与判死，且暂停期间存活计时不能继续老化；
 * 3. 反代字节在涨（极慢源）也算活：`/meter` 的 `bytesTotal` 增长要把
 *    `unresponsiveProbes` 清零，否则 1~2 KB/s 的源会被误判成死线；
 * 4. 出过画就再也不自动换线/换源（用户明确要求「已经能播放了 就不要切源」），
 *    后续卡顿按网络抖动处理。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const engine = readFileSync(resolve(here, "../../src/hooks/usePlayerEngine.ts"), "utf8");
// 判决规则（阈值计数、三态映射）抽成了纯模块，便于在 node 下直接跑行为单测
// （src/lib/watchdogVerdict.test.ts）；这里继续钉「引擎确实把判决交了出去、
// 而且交的是同一套阈值」，副作用顺序仍由下面几条源码契约守护。
const verdict = readFileSync(resolve(here, "../../src/lib/watchdogVerdict.ts"), "utf8");

describe("stall watchdog", () => {
  it("needs repeated unknown probes before switching lines", () => {
    expect(engine).toContain("const STALL_UNRESPONSIVE_LIMIT = 3;");
    // 引擎侧：阈值传给了判决模块，unknown 累计与到阈值判死都在那里发生。
    expect(engine).toContain("decideWatchdogVerdict({");
    expect(engine).toContain("limit: STALL_UNRESPONSIVE_LIMIT,");
    expect(engine).toContain("stall probe unresponsive");
    // 判决侧：unknown 累计、达阈值才 dead、计数不清零就不跳。
    expect(verdict).toContain("const next = unresponsiveProbes + 1;");
    expect(verdict).toContain("if (next >= limit) {");
  });

  it("never treats a paused video as a dead line", () => {
    expect(engine).toContain("if (video.paused && !video.ended)");
    // 暂停时把存活计时推到当前时刻：恢复播放后重新计窗口，而不是立刻判死。
    expect(engine).toContain("lastAliveAt = Date.now();");
  });

  it("stops switching once the video has actually played", () => {
    // 首帧标志真源已迁到 actor.hasPlayed（sessionHasPlayed 读），不再是本地 let。
    expect(engine).toContain("const sessionHasPlayed =");
    // 出过画之后看门狗直接让路：只撤慢提示，不判死。
    const guard = engine.indexOf("if (sessionHasPlayed()) {");
    const probe = engine.indexOf("probeLineVerdict(");
    expect(guard).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(probe);
    // hls 致命错误在播过之后也只提示、不跳源。
    expect(engine).toContain("网络波动导致播放中断");
  });

  it("counts proxy byte growth as a liveness signal", () => {
    expect(engine).toContain("bytesTotal");
    expect(engine).toContain("lastMeterTotal");
    // 关键顺序：先看字节有没有涨，再看控件是否还在（控件收起时也要记活）。
    const totalCheck = engine.indexOf("total > lastMeterTotal");
    const elementGuard = engine.indexOf("if (!speedEl) return;");
    expect(totalCheck).toBeGreaterThan(-1);
    expect(elementGuard).toBeGreaterThan(-1);
    expect(totalCheck).toBeLessThan(elementGuard);
    expect(engine).toContain("unresponsiveProbes = 0;");
  });
});

describe("sidebar playing dot", () => {
  it("uses the green ok token, not the accent color", () => {
    const css = readFileSync(resolve(here, "../../src/styles/layout.css"), "utf8");
    const start = css.indexOf(".nav__dot {");
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("}", start));
    expect(block).toContain("background: var(--ok);");
    expect(block).not.toContain("var(--accent)");
  });
});

describe("source picker row", () => {
  it("keeps avatar, name, favourite star and switch button on one row", () => {
    // 换源面板的样式住在 player-panels.css（组件归属），2026-11-16 从
    // command-palette.css 搬来；这里跟着换文件。
    const css = readFileSync(resolve(here, "../../src/styles/player-panels.css"), "utf8");
    const itemAt = css.indexOf(".source-item {");
    expect(itemAt, "锚点丢失：.source-item 基础规则去哪了？").toBeGreaterThanOrEqual(0);
    const block = css.slice(itemAt, css.indexOf("}", itemAt));
    // 四列固定：头像 32 / 名称弹性 / 星 30 / 按钮 76。少写一列时按钮会折到第二行压住站点名。
    expect(block).toContain("grid-template-columns: 32px minmax(0, 1fr) 30px 76px;");
    const favAt = css.indexOf(".source-item__fav.fav-star {");
    expect(favAt, "锚点丢失：收藏星的行内布局规则没了？").toBeGreaterThanOrEqual(0);
    const fav = css.slice(favAt, css.indexOf("}", favAt));
    expect(fav).not.toContain("flex:");
  });
});
