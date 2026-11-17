/**
 * 点播自动切换的顺序契约：**当前源同一集 → 当前源其它集 → 跨站换源**。
 *
 * 这段逻辑做过一次实测修正（1.0.4）：HLS fatal 与 kind=page 两个失败信号前后脚
 * 到，第二个看到「已在换线」就当失败，于是线路还在探活、页面已经跳到别的源了。
 * 顺序与去重都是不可见的时序行为，只能靠源码不变量守住。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("auto line switch order", () => {
  const player = read("src/pages/PlayerPage.tsx");

  it("tries the current source's lines before crossing sources", () => {
    const lineCall = player.indexOf("const switched = await tryNextLine();");
    const sourceCall = player.indexOf("await tryFailover();");
    expect(lineCall).toBeGreaterThan(0);
    expect(sourceCall).toBeGreaterThan(lineCall);
  });

  it("splits the candidates into same episode first,其它集 second", () => {
    expect(player).toContain("sameEpisodeName(episode.name, episodeName)");
    expect(player).toContain("const sameEpisode = usable");
    expect(player).toContain("const otherEpisodes = usable");
    const first = player.indexOf("await firstPlayable(sameEpisode");
    const second = player.indexOf("await firstPlayable(otherEpisodes");
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
  });

  it("dedupes concurrent failures by awaiting the in-flight attempt", () => {
    expect(player).toContain("const inflight = lineAttempt.current;");
    expect(player).toContain("return inflight;");
    // 不能再用「已开始就当失败」的布尔早退。
    expect(player).not.toContain("if (lineSwitchStarted.current) {");
  });

  it("tells the user which stage it is in", () => {
    expect(player).toContain("正在尝试同源的其它线路");
    expect(player).toContain("当前源没有可播线路，正在尝试其它源");
  });

  it("does not claim a source switch while switching lines", () => {
    // 2.0.0 起交棒文案集中在 `lib/sessionFailover.ts`（原先散在引擎 5 个交棒点），
    // 所以这条口径在那儿钉；引擎侧只把「为什么判死」交给机器。
    const copy = read("src/lib/sessionFailover.ts");
    expect(copy).toContain("正在切换线路");
    expect(copy).not.toContain("，正在换源");
  });
});
