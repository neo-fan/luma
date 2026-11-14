import { describe, expect, it } from "vitest";
import { locateEpisode, seedFromCachedDetail } from "./episodeSeed";
import type { PlayLine } from "./format";
import type { VodInfo } from "../types/tvbox";

const lines: PlayLine[] = [
  {
    name: "线路一",
    episodes: [
      { name: "第01集", url: "https://a.test/1.m3u8" },
      { name: "第02集", url: "https://a.test/2.m3u8" },
    ],
  },
  {
    name: "线路二",
    episodes: [
      { name: "第01集", url: "https://b.test/1.m3u8" },
      { name: "第02集", url: "https://b.test/2.m3u8" },
    ],
  },
];

function vod(overrides: Partial<VodInfo> = {}): VodInfo {
  return {
    vod_id: "42",
    vod_name: "庆余年",
    vod_pic: "https://img.test/p.jpg",
    vod_play_from: "线路一$$$线路二",
    vod_play_url:
      "第01集$https://a.test/1.m3u8#第02集$https://a.test/2.m3u8$$$第01集$https://b.test/1.m3u8#第02集$https://b.test/2.m3u8",
    ...overrides,
  } as VodInfo;
}

describe("locateEpisode", () => {
  it("按地址精确定位线路与集号", () => {
    expect(locateEpisode(lines, "https://b.test/2.m3u8")).toEqual({ line: 1, episode: 1 });
  });

  it("地址失配时按集名兜底，并优先 playFrom 指定的线路", () => {
    expect(locateEpisode(lines, "https://cdn-rotated.test/x.m3u8", "第02集", "线路二")).toEqual({
      line: 1,
      episode: 1,
    });
  });

  it("playFrom 对不上时按集名在其它线路里找", () => {
    expect(locateEpisode(lines, "", "第02集", "不存在的线路")).toEqual({ line: 0, episode: 1 });
  });

  it("全都对不上时回到第 1 集第 1 条", () => {
    expect(locateEpisode(lines, "", "", "")).toEqual({ line: 0, episode: 0 });
    expect(locateEpisode([], "https://a.test/1.m3u8", "第01集", "线路一")).toEqual({
      line: 0,
      episode: 0,
    });
  });
});

describe("seedFromCachedDetail", () => {
  it("命中缓存的详情：同步给出线路与当前集", () => {
    const seed = seedFromCachedDetail([vod()], "https://b.test/2.m3u8", "第02集", "线路二");
    expect(seed).not.toBeNull();
    expect(seed?.lines).toHaveLength(2);
    expect(seed?.locus).toEqual({ line: 1, episode: 1 });
    expect(seed?.vod?.vod_name).toBe("庆余年");
  });

  it("未命中 / 空详情返回 null，交给异步路径", () => {
    expect(seedFromCachedDetail(undefined, "https://a.test/1.m3u8")).toBeNull();
    expect(seedFromCachedDetail([], "https://a.test/1.m3u8")).toBeNull();
  });

  it("详情在但解析不出线路时不算命中（避免把空播放列表当成有效种子）", () => {
    const empty = vod({ vod_play_from: "", vod_play_url: "" });
    expect(seedFromCachedDetail([empty], "https://a.test/1.m3u8", "第01集")).toBeNull();
  });
});
