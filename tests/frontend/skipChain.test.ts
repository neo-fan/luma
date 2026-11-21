/**
 * 「跳过片尾 → 接下一集 → 跳过片头」这条链路的三个契约。
 *
 * 现网表现过的三个坏相：跳过片尾后新集停在第 0 秒、页面顶部弹一条「已自动播放
 * 下一集」、上一集的静止画面配着新一集的片头倒计时。前两个在页面/内核侧，第三个
 * 在倒计时 hook 侧，都是「谁掌握时机」的问题，因此按源码钉住顺序。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const controller = readFileSync(
  resolve(here, "../../src/hooks/playback/usePlaybackController.ts"),
  "utf8",
);
const engine = readFileSync(resolve(here, "../../src/hooks/usePlayerEngine.ts"), "utf8");
const page = readFileSync(resolve(here, "../../src/pages/PlayerPage.tsx"), "utf8");
const hook = readFileSync(resolve(here, "../../src/hooks/useAutoSkipPrompt.ts"), "utf8");

describe("resume intent survives the pause we cause ourselves", () => {
  it("captures the intent before halting the old stream", () => {
    // 顺序是这条修复的全部：halt 已经 pause 过，之后再读 paused 永远是 true，
    // 新集就会停在第 0 秒（跳过片尾后「视频被暂停」的实际成因）。
    for (const anchor of ["selectEpisode = useCallback", "switchSource = useCallback"]) {
      const at = controller.indexOf(anchor);
      expect(at, `missing ${anchor}`).toBeGreaterThan(-1);
      const body = controller.slice(at, at + 2000);
      const capture = body.indexOf("captureResumeIntent();");
      const halt = body.indexOf("haltCurrentPlayback();");
      expect(capture, `${anchor} 里没有取播放意图`).toBeGreaterThan(-1);
      expect(halt, `${anchor} 里没有停旧流`).toBeGreaterThan(-1);
      expect(capture).toBeLessThan(halt);
    }
  });

  it("does not re-read the DOM during a burst of clicks", () => {
    // 连点第二集时视频已经被我们自己按停，重取会把「想接着看」判成「想暂停」。
    expect(controller).toContain('if (phaseRef.current !== "idle") {');
    expect(controller).toContain("resumeIntentRef.current = Boolean(video && !video.paused && !video.ended);");
  });

  it("passes the intent through the engine instead of guessing", () => {
    expect(controller).toContain("await engine.switchSource(play.proxyUrl, resume);");
    expect(engine).toContain("const wasPlaying = resume ?? (!video.paused && !video.ended);");
  });
});

describe("skip outro notice stays inside the player", () => {
  it("uses the player notice, not the page toast", () => {
    const at = page.indexOf("const advanceToNext = useCallback");
    expect(at).toBeGreaterThan(-1);
    const body = page.slice(at, at + 1200);
    expect(body).toContain("engine.notice(");
    expect(body).not.toContain("notify.");
  });
});

describe("intro countdown is driven by the video, not by state edges", () => {
  it("starts from the player's own playback events", () => {
    // 以前靠「窗口态翻转」判边沿：换集时新旧两集都在片头里，true→true 不算边沿，
    // 整集不跳（第 34/35 集实测）。现在只问一件事——这一集此刻播到哪儿了。
    expect(hook).toContain('video.addEventListener("playing", check);');
    expect(hook).toContain('video.addEventListener("timeupdate", check);');
    expect(hook).toContain("shouldSkipIntro(curMs, introMs)");
    expect(hook).toContain("shouldSkipOutro(curMs, durMs, outroMs)");
    // 边沿判定函数与它依赖的窗口态上报一起下线了，别再长回来。
    expect(hook).not.toContain("shouldAutoSkipPrompt");
    expect(engine).not.toContain("onSkipState");
  });

  it("prompts at most once per episode, and never when the switch is off", () => {
    expect(hook).toContain("doneRef.current = { intro: false, outro: false };");
    expect(hook).toContain("const pendingKind = pendingRef.current?.kind;");
    expect(hook).toContain("if (!video || !enabled || (introMs <= 0 && outroMs <= 0)) {");
    // 本集「提示过没有」跟着媒体身份复位：换集/换源/实例重建都要重来一次。
    expect(hook).toContain("}, [mediaKey, attachSignal, cancel]);");
  });

  it("drops the countdown when playback leaves the segment (resume seek)", () => {
    // `playing` 可能在历史续播 seek 之前于第 0 秒触发；若只判断「有 pending 就 return」，
    // 5 秒后会把用户从续播点拽回片头末尾。倒计时要跟着播放头走。
    expect(hook).toContain('if (pendingKind === "intro" && !shouldSkipIntro(curMs, introMs)) {');
    expect(hook).toContain('if (pendingKind === "outro" && !shouldSkipOutro(curMs, durMs, outroMs)) {');
    expect(page).toContain("if (v && intro > 0 && v.currentTime * 1000 < intro) {");
  });
});

describe("auto next never overrides a pending pick", () => {
  it("refuses to advance while the user's selection has not landed", () => {
    const at = page.indexOf("const advanceToNext = useCallback");
    expect(at).toBeGreaterThan(-1);
    expect(page.slice(at, at + 400)).toContain("if (display !== committed) {");
  });
});