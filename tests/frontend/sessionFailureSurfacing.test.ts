import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 「有速度、没画面、没出口」的回归契约。
 *
 * 现场：一条 502 的死链上，反代仍在被反复重拉（速度条一直在动），机器其实早已
 * `failed`，但界面既没有错误卡也没有出口——只剩一个永远转的圈，用户只能猜。
 * 三个原因各钉一条：
 * 1. 判死文案只由交棒副作用写（`sessionEffectsRef` 在实例重建窗口里为 null，
 *    副作用按设计 no-op），机器 failed 却没人告诉 UI；
 * 2. 判死后解码器继续 `loadSource`，每 13~16s 重拉一遍同一份失败清单；
 * 3. 错误卡出来了，上面还压着一句「源侧响应较慢，正在等待」——两条相反的判断。
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(here, "../../src", path), "utf8");

describe("a dead line always surfaces a visible failure", () => {
  const engine = read("hooks/usePlayerEngine.ts");
  const decoders = read("hooks/playerDecoders.ts");
  const page = read("pages/PlayerPage.tsx");

  it("derives the copy from machine state instead of relying on the handover callback", () => {
    expect(engine).toContain('snap.matches("failed")');
    expect(engine).toContain("setSessionFailure(");
    // 句柄要把它交给页面（并进 useMemo 依赖，否则失败的更新不会渲染）。
    expect(engine).toContain("sessionFailure,");
    expect(engine).toContain("[machineSwitching, sessionFailure],");
  });

  it("stops reloading the manifest once the session is dead", () => {
    const start = decoders.indexOf("hls.on(Hls.Events.ERROR");
    expect(start, "锚点丢失：hls ERROR 订阅被改写？").toBeGreaterThanOrEqual(0);
    const end = decoders.indexOf('host.session.failover("hlsFatal"', start);
    expect(end, "锚点丢失：hlsFatal 交棒不见了？").toBeGreaterThan(start);
    // 守卫必须在重连之前：它挡的正是「已判死还要再拉一遍」。
    expect(decoders.slice(start, end)).toContain("host.session.isFailed()");
  });

  it("merges the derived failure into the stage's error and drops the slow hint", () => {
    expect(page).toContain("const playbackError = videoError || engine.sessionFailure;");
    expect(page).toContain("playbackError={playbackError}");
    // 有结论时不再显示「正在等」，否则用户不知道该等还是该换。
    expect(page).toContain('const text = playbackError ? "" : switchTip || slowNotice;');
  });
});
