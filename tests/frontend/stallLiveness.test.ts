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
// 交棒文案与日志 stage 的唯一来源（5 个交棒点 2.0.0 起合成一处）。
const failoverCopy = readFileSync(resolve(here, "../../src/lib/sessionFailover.ts"), "utf8");

// 看门狗 2.0.0 起独立成 `playerStallWatchdog.ts`（那里有 12 条行为测试）；
// 判决在状态机转换表；这里只钉「三块各自的位置没跑偏」与几条真实回归的接线。
const watchdog = readFileSync(resolve(here, "../../src/hooks/playerStallWatchdog.ts"), "utf8");

describe("stall watchdog", () => {
  it("needs repeated unknown probes before switching lines", () => {
    // 唯一真源在机器：看门狗与解释器都不留阈值副本、不留计数器副本，也没有第二个判决模块。
    expect(watchdog).not.toContain("STALL_UNRESPONSIVE_LIMIT");
    expect(engine).not.toContain("STALL_UNRESPONSIVE_LIMIT");
    expect(engine).not.toContain("let unresponsiveProbes");
    expect(engine).not.toContain("decideWatchdogVerdict");
    expect(vodMachine).toContain("export const UNRESPONSIVE_LIMIT = 3;");
    expect(vodMachine).toContain("context.unresponsiveProbes + 1 >= UNRESPONSIVE_LIMIT");
    // 看门狗只交证据（不翻译 ok↔alive），引擎把结论原样转给机器，
    // 交棒由机器进入 recovering 时回调唯一的实现点 handOverLine 完成。
    expect(watchdog).toContain('send({ type: "PROBE", verdict })');
    expect(engine).toContain("send: (event) => sessionActorRef.current?.send(event)");
    expect(engine).not.toContain('matches("recovering")');
    expect(engine).toContain("navigateFailover");
    expect(engine).toContain("requestLineSwitch");
    expect(engine).toContain("const handOverLine =");
    // 文案与日志 stage 的唯一来源。
    expect(failoverCopy).toContain("stall probe unresponsive");
    expect(failoverCopy).toContain("stall probe dead");
  });

  it("never treats a paused video as a dead line", () => {
    expect(watchdog).toContain("if (video.paused && !video.ended)");
    // 暂停时把存活计时推到当前时刻：恢复播放后重新计窗口，而不是立刻判死。
    expect(watchdog).toContain("markAlive();");
    // 静默只是触发器，不是判决——时间不够就不探。
    expect(watchdog).toContain("if (quietMs() < STALL_QUIET_MS) {");
  });

  it("stops switching once the video has actually played", () => {
    // 首帧标志真源 = actor.hasPlayed，看门狗通过注入的 hasPlayed() 读它。
    expect(engine).toContain("hasPlayed: sessionHasPlayed");
    expect(watchdog).toContain("if (hasPlayed()) {");
    // 探的是「当前真实地址」：原地换集后 resolved 不变，照旧地址探会误杀新一集。
    expect(engine).toContain("probeTarget: () => ({ url: activeProxyUrl, kind: resolved.kind })");
    // 同一条红线还写进了转换表：就算解释器漏掉那个 if，机器也进不了判死路径。
    expect(vodMachine).toContain('STALL: { target: "probing", guard: "notPlayed" }');
    expect(vodMachine).toContain("notPlayed: ({ context }) => !context.hasPlayed");
    // hls 致命错误在播过之后也只提示、不跳源（解码器侧，见 playerDecoders）。
    const decoders = readFileSync(resolve(here, "../../src/hooks/playerDecoders.ts"), "utf8");
    expect(decoders).toContain("网络波动导致播放中断");
  });

  it("counts proxy byte growth as a liveness signal", () => {
    // 2.0.0 起轮询本体在 `playerThroughputMeter.ts`（6 条行为测试钉增长/倒退/NaN）。
    const meter = readFileSync(resolve(here, "../../src/hooks/playerThroughputMeter.ts"), "utf8");
    expect(meter).toContain("bytesTotal");
    expect(meter).toContain("total > lastTotal");
    // 关键顺序：先判增长（记活），再渲染速率——控件收起时也要记活。
    const growthCheck = meter.indexOf("total > lastTotal");
    const renderCall = meter.indexOf("render(`↓ ${rate}`)");
    expect(growthCheck).toBeGreaterThan(-1);
    expect(renderCall).toBeGreaterThan(growthCheck);
    // 取不到数据不能闪 0：catch 分支必须保持空实现（不写 label、不清零）。
    expect(meter).toContain("反代重启中：保持上一次读数，不闪 0");
    // 引擎侧：增长这条证据交给机器复位，解释器不自己清零计数器。
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
