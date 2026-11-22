/**
 * 起播音频淡入的源码契约（频道切换起播时音量不能突变/漏一声）。
 *
 * 2.0.0 起淡入本体抽到 `src/hooks/playerVolumeFade.ts`，那里有 10 条**行为**测试
 * （假时钟 + 假帧队列，能精确断言「先立静默窗再取消静音」这类顺序），比读源码
 * 字符串强得多。所以本文件不再抄一遍内部实现，只钉三件仍然只在引擎里成立的事：
 *
 * 1. 引擎确实**委托**给那个模块，并且全仓**只有这一份**淡入实现（不许再出现
 *    第二处 `requestAnimationFrame` 爬坡——原先冷启动与换集各抄一份，正是
 *    「拖音量后换集丢音量」的产地）；
 * 2. 硬停时必须先静音再 `pause()`，拖着一小段缓冲直接掐断会留一声爆音；
 * 3. 落盘闸门仍按静默窗判断，且**不能**用「淡入还没开始」压住用户操作。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const engine = readFileSync(resolve(root, "src/hooks/usePlayerEngine.ts"), "utf8");
const fader = readFileSync(resolve(root, "src/hooks/playerVolumeFade.ts"), "utf8");
const writer = readFileSync(resolve(root, "src/hooks/playerPrefsWriter.ts"), "utf8");

describe("player audio fade", () => {
  it("delegates the fade to a single implementation", () => {
    expect(engine).toContain('import { createVolumeFader } from "./playerVolumeFade";');
    expect(engine).toContain("fader.armColdStart();");
    expect(engine).toContain("fader.armSwitch({ volume: swVolume, muted: swMuted })");
    // 引擎里不再自己爬坡：淡入只有一处实现。
    expect(engine).not.toContain("requestAnimationFrame(");
    expect(engine).not.toContain("FADE_IN_MS");
    // 内部公式与监听器参数由 playerVolumeFade.test.ts 的行为测试覆盖，这里只守委托不重复。
  });

  it("mutes before pausing when tearing the player down", () => {
    const hardStopAnchor = engine.indexOf("const hardStop = () => {");
    expect(hardStopAnchor, "锚点丢失：hardStop 函数名变了？").toBeGreaterThanOrEqual(0);
    const hardStop = engine.slice(hardStopAnchor);
    const muteAt = hardStop.indexOf("video.muted = true;");
    const pauseAt = hardStop.indexOf("video.pause();");
    expect(muteAt).toBeGreaterThan(-1);
    expect(pauseAt).toBeGreaterThan(-1);
    expect(muteAt).toBeLessThan(pauseAt);
  });

  it("does not persist the volume while the fade is running", () => {
    // 落盘闸门 2.0.0 起归 `playerPrefsWriter.ts`（那里有 9 条行为测试）。
    const gate = "if (now() < fader.silentUntil) {";
    expect(writer).toContain(gate);
    // 「淡入还没开始」不能压住落盘：自动播放被拦时淡入闸门恒关，
    // 用户在起播前拖的音量会被整段吞掉（2026-11-16 探针回归实测）。
    expect(writer).not.toContain("!fader.fadeDone || now() < fader.silentUntil");
    // 引擎侧：卸载补写仍要求淡入完成且过了静默窗，且不再自己维护节流状态。
    expect(engine).toContain("if (fader.fadeDone && Date.now() >= fader.silentUntil) {");
    expect(engine).not.toContain("let volumeTrailing");
    expect(engine).toContain("prefsWriter.dispose();");
    // 淡入的监听与兜底定时器由模块统一回收，引擎不再手写三份 removeEventListener。
    expect(engine).toContain("posterHold.dispose();");
    expect(engine).not.toContain('video.removeEventListener("playing", fadeInVolume);');
  });

  it("keeps the volume icon able to restore sound", () => {
    // 上次静音 / 音量 0 就保持静音，别摊成「没静音但没声音」（淡入侧）
    expect(fader).toContain("if (wanted.muted || wanted.volume <= AUDIBLE_FLOOR) {");
    // 从静音恢复但音量还是 0 时，补回最近一次有声的音量（写入器侧）
    expect(writer).toContain("video.volume = fader.lastAudible;");
    // 静音状态要跟音量一起落盘，否则重开又回到默认有声
    expect(writer).toContain("write({ volume: video.volume, muted: video.muted });");
  });
});
