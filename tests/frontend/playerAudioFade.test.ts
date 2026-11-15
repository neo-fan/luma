/**
 * 起播音频淡入的源码契约（2026-11-15 用户反馈「直播频道切换时候 有个声音」）。
 *
 * 两条约束不能退化：
 * 1. 新实例必须先静音（`muted = true` + `volume = 0`）等 `playing` 再淡入，
 *    否则 ArtPlayer 初始化时会把音量恢复成自己缓存的 100%，首帧就是满音量；
 * 2. 硬停时必须先静音再 `pause()`，拖着一小段缓冲直接掐断会留一声爆音。
 *
 * 这些都在 `usePlayerEngine.ts` 里，靠行为测试要真起播放器，用源码契约兜住。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const engine = readFileSync(resolve(root, "src/hooks/usePlayerEngine.ts"), "utf8");

describe("player audio fade", () => {
  it("mutes the element and starts from zero volume", () => {
    expect(engine).toContain("const FADE_IN_MS = 200;");
    expect(engine).toContain("video.muted = true;");
    expect(engine).toContain("video.volume = 0;");
    expect(engine).toContain('video.addEventListener("playing", fadeInVolume, { once: true });');
  });

  it("fades in to the remembered volume instead of jumping to it", () => {
    const fade = engine.slice(engine.indexOf("const fadeInVolume = () => {"));
    expect(fade).toContain("readPlayerPrefs().volume");
    expect(fade).toContain("video.volume = wanted * progress;");
    expect(fade).toContain("window.requestAnimationFrame(tick);");
  });

  it("mutes before pausing when tearing the player down", () => {
    const hardStop = engine.slice(engine.indexOf("const hardStop = () => {"));
    const muteAt = hardStop.indexOf("video.muted = true;");
    const pauseAt = hardStop.indexOf("video.pause();");
    expect(muteAt).toBeGreaterThan(-1);
    expect(pauseAt).toBeGreaterThan(-1);
    expect(muteAt).toBeLessThan(pauseAt);
  });

  it("does not persist the volume while the fade is running", () => {
    expect(engine).toContain("let volumeFadeUntil = 0;");
    expect(engine).toContain("if (Date.now() < volumeFadeUntil) {");
    // 「淡入还没开始」不能压住落盘：自动播放被拦时 fadeDone 恒 false，
    // 用户在起播前拖的音量会被整段吞掉（2026-11-16 探针回归实测）。
    expect(engine).not.toContain("if (!fadeDone || Date.now() < volumeFadeUntil) {");
    expect(engine).toContain("if (fadeDone && Date.now() >= volumeFadeUntil) {");
    expect(engine).toContain('video.removeEventListener("playing", fadeInVolume);');
    expect(engine).toContain('video.removeEventListener("canplay", fadeIfPlaying);');
    expect(engine).toContain("window.clearTimeout(fadeTimer);");
  });

  it("keeps the volume icon able to restore sound", () => {
    // 淡入前先立静默窗口：否则 muted=false 触发的那次 volumechange 会把 0
    // 写进偏好，之后「点图标取消静音」也没有声音（2026-11-15 实测）。
    const order = engine.indexOf("volumeFadeUntil = Date.now() + FADE_IN_MS + 150;");
    const unmute = engine.indexOf("video.muted = false;", order);
    expect(order).toBeGreaterThan(-1);
    expect(unmute).toBeGreaterThan(order);
    // 上次静音 / 音量 0 就保持静音，别摊成「没静音但没声音」
    expect(engine).toContain("if (stored.muted || wanted <= 0.01) {");
    // 从静音恢复但音量还是 0 时，补回最近一次有声的音量
    expect(engine).toContain("video.volume = lastAudible;");
    // 静音状态要跟音量一起落盘，否则重开又回到默认有声
    expect(engine).toContain(
      "writePlayerPrefs({ volume: video.volume, muted: video.muted });",
    );
  });
});
