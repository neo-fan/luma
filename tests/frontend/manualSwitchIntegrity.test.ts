import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 手动切换的「UI 即最终渲染依据」契约（整体重写版）：
 *
 * 1. 换源面板的「切换」按钮 hover 必须是实心白（--solid），不能被 polish.css
 *    的通用次级按钮规则（--panel-hover）吃掉。
 * 2. 换源是最强用户意图：发起时作废换集乐观意图（dispatch cancel）并清空排队，
 *    显示收敛到即将落地的单个 PlaybackTarget。
 * 3. 换源落地是「整份 target 替换」：内部线路索引随它一起提交，选集面板天然跟随，
 *    不再需要对 panelLine 做事后补丁。
 *
 * 组件测试环境没装 jsdom，按项目惯例读源码断言关键结构。
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) =>
  readFileSync(resolve(here, "../../src", path), "utf8");
const styles = (path: string) =>
  readFileSync(resolve(here, "../../src/styles", path), "utf8");

const CONTROLLER = "hooks/playback/usePlaybackController.ts";

describe("manual source switch integrity", () => {
  const css = styles("player-panels.css");

  it("gives the source-pick button a solid-white hover with winning specificity", () => {
    // 0,5,0：.source-list .source-item:hover .source-item__pick:not(:disabled)
    expect(css).toContain(
      ".source-list .source-item:hover .source-item__pick:not(:disabled)",
    );
    const block = css.slice(
      css.indexOf(".source-list .source-item:hover .source-item__pick:not(:disabled)"),
    );
    expect(block.slice(0, 220)).toContain("background: var(--solid)");
    expect(block.slice(0, 220)).toContain("color: var(--solid-ink)");
  });

  it("clears the episode intent and queue when a source switch takes over", () => {
    const ctl = source(CONTROLLER);
    const pick = ctl.slice(ctl.indexOf("const switchSource = useCallback("));
    expect(pick.length).toBeGreaterThan(0);
    const head = pick.slice(0, pick.indexOf("const list = await api.detail"));
    // 换源发起即作废乐观意图与排队，显示收敛到最终目标。
    expect(head).toContain('dispatch({ type: "cancel" })');
    expect(head).toContain("switchQueueRef.current?.cancelPending()");
  });

  it("commits the whole new target so the panel follows the landed line", () => {
    const ctl = source(CONTROLLER);
    const pick = ctl.slice(ctl.indexOf("const switchSource = useCallback("));
    const nextTarget = pick.slice(pick.indexOf("const nextTarget: PlaybackTarget"));
    const targetBlock = nextTarget.slice(0, nextTarget.indexOf("};"));
    // 线路索引是 target 的一部分，落地即跟随。
    expect(targetBlock).toContain("lineIndex,");
    // 换源与换集共用同一个落地口（applySwitch 一次提交整份 target）。
    expect(pick).toContain("nextTarget,");
    expect(ctl).toContain('dispatch({ type: "commit", target })');
    expect(ctl).toContain("const applySwitch = useCallback(");
  });

  it("exposes the panel line setter from the controller to the page", () => {
    const ctl = source(CONTROLLER);
    expect(ctl).toContain("setPanelLine: (value: number) => void;");
    const page = source("pages/PlayerPage.tsx");
    expect(page).toContain("setPanelLine,");
  });
});
