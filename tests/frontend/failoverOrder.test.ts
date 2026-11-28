/**
 * 自动切换已停用：换线 / 换源只能由 UI 选择发起，且不做可用性预检。
 *
 * 这条红线来自现网反馈——用户手动切到布布追剧后，hls fatal 让看门狗判死，
 * 自愈总线又把他换回欧乐影院；「切换以 UI 为准」必须是源码级不变量，不能靠
 * 调用方自觉。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("automatic failover is disabled", () => {
  const orchestration = read("src/hooks/playback/usePlaybackController.ts");
  const playerPage = read("src/pages/PlayerPage.tsx");
  const livePage = read("src/pages/LivePage.tsx");

  it("controller no longer probes candidates or crosses sources on its own", () => {
    expect(orchestration).not.toContain("tryNextLine");
    expect(orchestration).not.toContain("tryFailover");
    expect(orchestration).not.toContain("firstPlayable");
    expect(orchestration).not.toContain("probePlayable");
    expect(orchestration).not.toContain("switchOrFailover");
    expect(orchestration).not.toContain("auto failover");
  });

  it("manual next-line switches optimistically to the same episode", () => {
    expect(orchestration).toContain("const nextLine = useCallback(() => {");
    expect(orchestration).toContain("const targetLine = (c.lineIndex + 1) % total;");
    expect(orchestration).toMatch(/selectEpisode\(targetLine, index, "正在切换线路…"\)/);
  });

  it("the episode panel follows the line through derivation, not manual patching", () => {
    // 面板线路必须**派生自播放目标**（`resolvePanelLine(browse, display)`），
    // 而不是一份独立 state 由每个切换路径手动同步。历史上这里靠四处
    // `setPanelLineState(...)` 补：漏一处就退化成「播放器切了线路、下面选集区
    // 还列着旧线路的剧集」——「换下一条线路」正是这么漏的。
    expect(orchestration).toContain("const panelLine = resolvePanelLine(browse, display);");
    // 反向断言：控制器里不允许再出现手动同步的写法。
    expect(orchestration).not.toContain("setPanelLineState");
    // 浏览覆盖只在用户点 chip 时写入，且必须带锚（目标线路），否则不会过期。
    expect(orchestration).toContain(
      "setBrowse({ line: value, anchor: displayRef.current.lineIndex });",
    );
  });

  it("vod page never calls an auto switch on resolve/playback failure", () => {
    expect(playerPage).not.toContain("switchOrFailoverRef");
    expect(playerPage).not.toContain("正在尝试其它线路");
  });

  it("live page keeps only the manual line button", () => {
    expect(livePage).toContain("const selectNextLine = useCallback(");
    expect(livePage).toContain("selectNextLine();");
    expect(livePage).not.toMatch(/void switchOrFailoverRef\.current\(\)/);
  });
});