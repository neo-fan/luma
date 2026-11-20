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

describe("intro countdown waits for the new episode to actually play", () => {
  it("arms instead of starting when the picture is not there yet", () => {
    // 换集后窗口态在 loadedmetadata 就到（此时还是上一集的静止帧），
    // 立刻显示倒计时会读成「跳过片头还是上一集的」。
    expect(hook).toContain("armedRef.current = kind;");
    expect(hook).toContain("if (readyRef.current()) {");
    // 待命期间的轮询：出画即起跑，不必等下一次窗口翻转。
    expect(hook).toContain("if (!readyRef.current()) {");
  });

  it("treats a not-yet-playing episode as not ready", () => {
    expect(page).toMatch(/!v\.paused && v\.readyState >= 3/);
  });
});