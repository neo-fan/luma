import { describe, expect, it } from "vitest";
import { groupEpisodes } from "./episodeGroups";

/** 造一条 0..n-1 的原始序列，字段形状与选集区一致。 */
const episodes = (total: number) =>
  Array.from({ length: total }, (_, index) => ({ index, name: `第${index + 1}集` }));

describe("groupEpisodes", () => {
  it("splits a long list into fixed-size chunks with original episode numbers", () => {
    const groups = groupEpisodes(episodes(221));
    expect(groups.map((group) => group.label)).toEqual([
      "第 1–50 集",
      "第 51–100 集",
      "第 101–150 集",
      "第 151–200 集",
      "第 201–221 集",
    ]);
    expect(groups[4].items).toHaveLength(21);
    expect(groups[0].items[0].index).toBe(0);
  });

  it("labels reversed chunks by episode number, not display position", () => {
    const reversed = episodes(221).reverse();
    const groups = groupEpisodes(reversed);
    expect(groups[0].label).toBe("第 172–221 集");
    // 段内仍保持传进来的顺序（这里是最新集在前）。
    expect(groups[0].items[0].index).toBe(220);
    expect(groups[4].label).toBe("第 1–21 集");
  });

  it("keeps short lists in a single group", () => {
    expect(groupEpisodes(episodes(50))).toHaveLength(1);
    expect(groupEpisodes(episodes(51))).toHaveLength(2);
    expect(groupEpisodes([])).toEqual([]);
  });

  it("names a single-episode group without a range", () => {
    const groups = groupEpisodes(episodes(51));
    expect(groups[1].label).toBe("第 51 集");
  });

  it("takes filtered lists as-is and keeps keys unique", () => {
    const picked = [episodes(221)[199], episodes(221)[179], episodes(221)[4]];
    const groups = groupEpisodes(picked, 2);
    expect(groups[0].label).toBe("第 180–200 集");
    expect(new Set(groups.map((group) => group.key)).size).toBe(groups.length);
  });
});
