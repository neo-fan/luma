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
    expect(engine).toContain("if (Date.now() >= volumeFadeUntil) {");
    expect(engine).toContain('video.removeEventListener("playing", fadeInVolume);');
  });
});
