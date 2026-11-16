/**
 * 卡顿看门狗的「慢 ≠ 死」契约。
 *
 * 这一层不跑真实视频（jsdom 没有 MSE），所以按源码文本钉住几条不能丢的判据：
 *
 * 1. `unknown` 要累计到阈值才换线，不能一次探活失败就跳；
 * 2. 暂停不参与判死，且暂停期间存活计时不能继续老化；
 * 3. 反代字节在涨（极慢源）也算活：`/meter` 的 `bytesTotal` 增长要把机器里的
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
// 判决（unknown 累计、阈值、出画后不判死、判死后交棒）2.0.0 起只在会话状态机的
// 转换表里发生，由 node 下的行为单测直接跑（src/lib/vodSessionMachine.test.ts /
// liveSessionMachine.test.ts）；这里钉「引擎把结论交给了机器、且不再自带阈值与
// 计数器副本」，副作用顺序仍由下面几条源码契约守护。
const vodMachine = readFileSync(resolve(here, "../../src/lib/vodSessionMachine.ts"), "utf8");

describe("stall watchdog", () => {
  it("needs repeated unknown probes before switching lines", () => {
    // 唯一真源在机器：解释器不留阈值副本、不留计数器副本，也没有第二个判决模块。
    expect(engine).not.toContain("STALL_UNRESPONSIVE_LIMIT");
    expect(engine).not.toContain("let unresponsiveProbes");
    expect(engine).not.toContain("decideWatchdogVerdict");
    expect(vodMachine).toContain("export const UNRESPONSIVE_LIMIT = 3;");
    expect(vodMachine).toContain("context.unresponsiveProbes + 1 >= UNRESPONSIVE_LIMIT");
    // 引擎侧：结论原样喂进机器（不再翻译 ok↔alive），交棒与否由机器的状态说话。
    expect(engine).toContain('actor.send({ type: "PROBE", verdict })');
    expect(engine).toContain('actor.getSnapshot().matches("recovering")');
    expect(engine).toContain("stall probe unresponsive");
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
    // 同一条红线还写进了转换表：就算解释器漏掉那个 if，机器也进不了判死路径。
    expect(vodMachine).toContain('STALL: { target: "probing", guard: "notPlayed" }');
    expect(vodMachine).toContain("notPlayed: ({ context }) => !context.hasPlayed");
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
    // 涨了就把「极慢但活着」这条证据交给机器复位，解释器不自己清零。
    expect(engine).toContain('send({ type: "FRAG_GROWTH" })');
    expect(engine).not.toContain("unresponsiveProbes = 0;");
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
