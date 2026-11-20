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
    expect(orchestration).toContain("selectEpisode(targetLine, index);");
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

  it("failure copy never promises an automatic switch", () => {
    const copy = read("src/lib/sessionFailover.ts");
    expect(copy).not.toContain("正在切换");
    expect(copy).not.toContain("正在找其它源");
    expect(copy).toContain("换线路或换源");
  });
});