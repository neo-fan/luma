import { describe, expect, it } from "vitest";
import {
  collectSourceOptions,
  countEpisodes,
  episodeNumber,
  pickMatchingEpisode,
} from "./sources";
import type { AggregateRow, SourceSite } from "./sources";
import type { PlayLine } from "./format";
import type { ResultPage, VodInfo } from "../types/tvbox";

const keyword = "嫁金钗";

/** 构造一条完整 VodInfo；缺省为精确命中「嫁金钗」的条目。 */
function makeVod(vodName = "嫁金钗", vodId = "1"): VodInfo {
  return {
    vod_id: vodId,
    vod_name: vodName,
    vod_pic: "",
    vod_play_from: "",
    vod_play_url: "",
  };
}

/** 构造完整 ResultPage（严格模式下补齐必填字段）。 */
function makePage(list: VodInfo[]): ResultPage {
  return {
    list,
    filters: {},
    pagecount: 1,
    page: 1,
    limit: list.length,
    total: list.length,
  };
}

/** list 为 undefined 时表示「无 data.list」。 */
function makeRow(siteKey: string, list: VodInfo[] | undefined, ok = true): AggregateRow {
  const row: AggregateRow = { siteKey, ok };
  if (list !== undefined) {
    row.data = makePage(list);
  }
  return row;
}

function makeSite(
  key: string,
  name: string,
  runtime: SourceSite["runtime"] = "python",
  enabled = true,
): SourceSite {
  return { key, name, runtime, enabled };
}

function makeLines(spec: { name: string; episodes: string[] }[]): PlayLine[] {
  return spec.map((line) => ({
    name: line.name,
    episodes: line.episodes.map((name) => ({ name, url: `m3u8://${line.name}/${name}` })),
  }));
}

describe("collectSourceOptions", () => {
  // 真实片名按 titleMatchScore：嫁金钗=3、嫁金钗 田曦薇=2、金钗谍影=1、三嫁公主/石匠的耳朵=0。
  const scoredSites: SourceSite[] = [
    makeSite("s1", "源甲"),
    makeSite("s2", "源乙"),
    makeSite("s3", "源丙"),
    makeSite("s4", "源丁"),
    makeSite("s5", "源戊"),
  ];
  const scoredRows: AggregateRow[] = [
    makeRow("s3", [makeVod("金钗谍影")]),
    makeRow("s1", [makeVod("嫁金钗")]),
    makeRow("s2", [makeVod("嫁金钗 田曦薇")]),
    makeRow("s4", [makeVod("三嫁公主")]),
    makeRow("s5", [makeVod("石匠的耳朵")]),
  ];

  it("跳过 ok:false / 无 data.list / 无 vod_id / 无 vod_name 的行", () => {
    const rows: AggregateRow[] = [
      makeRow("off", [makeVod()], false),
      makeRow("noData", undefined),
      makeRow("emptyList", []),
      makeRow("noId", [makeVod("嫁金钗", "")]),
      makeRow("noName", [makeVod("", "9")]),
      makeRow("good", [makeVod()]),
    ];
    // sites 为空时站点名回退到 siteKey，不影响跳过逻辑。
    const sites: SourceSite[] = [];
    expect(collectSourceOptions(rows, keyword, sites).map((r) => r.siteKey)).toEqual(["good"]);
  });

  it("按 minScore 过滤并按 matchScore 降序排列", () => {
    const result = collectSourceOptions(scoredRows, keyword, scoredSites);
    expect(result.map((r) => [r.siteKey, r.matchScore])).toEqual([
      ["s1", 3],
      ["s2", 2],
      ["s3", 1],
    ]);
  });

  it("minScore=2 时丢弃相关度为 1 的候选", () => {
    const result = collectSourceOptions(scoredRows, keyword, scoredSites, undefined, 2);
    expect(result.map((r) => r.siteKey)).toEqual(["s1", "s2"]);
  });

  it("minScore=0 时保留 0 分候选（三嫁公主按规则为 0 分）", () => {
    const rows: AggregateRow[] = [makeRow("weak", [makeVod("三嫁公主")])];
    const sites: SourceSite[] = [makeSite("weak", "弱相关")];
    const result = collectSourceOptions(rows, keyword, sites, undefined, 0);
    expect(result).toHaveLength(1);
    expect(result[0].matchScore).toBe(0);
  });

  it("同一站点只保留得分最高的一条", () => {
    const sites: SourceSite[] = [makeSite("s1", "源一")];
    const rows: AggregateRow[] = [
      makeRow("s1", [
        makeVod("嫁金钗 田曦薇", "a"),
        makeVod("嫁金钗", "b"),
        makeVod("金钗谍影", "c"),
      ]),
    ];
    const result = collectSourceOptions(rows, keyword, sites);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ vodName: "嫁金钗", vodId: "b", matchScore: 3 });
  });

  it("同一站点出现多行时去重，只保留跨行最高分", () => {
    const sites: SourceSite[] = [makeSite("s1", "源一")];
    const rows: AggregateRow[] = [
      makeRow("s1", [makeVod("嫁金钗 田曦薇", "a")]),
      makeRow("s1", [makeVod("嫁金钗", "b")]),
      makeRow("s1", [makeVod("金钗谍影", "c")]),
    ];
    const result = collectSourceOptions(rows, keyword, sites);
    expect(result).toHaveLength(1);
    expect(new Set(result.map((r) => r.siteKey)).size).toBe(1);
    expect(result[0]).toMatchObject({ vodName: "嫁金钗", matchScore: 3 });
  });

  it("excludeSiteKey 排除当前源", () => {
    const sites: SourceSite[] = [makeSite("current", "当前源"), makeSite("other", "其他源")];
    const rows: AggregateRow[] = [
      makeRow("current", [makeVod()]),
      makeRow("other", [makeVod()]),
    ];
    expect(
      collectSourceOptions(rows, keyword, sites, "current").map((r) => r.siteKey),
    ).toEqual(["other"]);
  });

  it("保留 quickjs 站点，跳过 enabled:false / jvm 站点", () => {
    const sites: SourceSite[] = [
      makeSite("normal", "正常"),
      makeSite("off", "停用", "python", false),
      makeSite("jar", "Jar源", "jvm"),
      makeSite("js", "JS源", "quickjs"),
      makeSite("cms", "CMS源", "cms"),
    ];
    const rows: AggregateRow[] = sites.map((site) => makeRow(site.key, [makeVod()]));
    const result = collectSourceOptions(rows, keyword, sites);
    expect(result.map((r) => r.siteKey).sort()).toEqual(["cms", "js", "normal"]);
  });

  it("同分按站点名 localeCompare('zh-CN') 排序（安 < 波 < 中）", () => {
    const sites: SourceSite[] = [
      makeSite("k_zhong", "中"),
      makeSite("k_an", "安"),
      makeSite("k_bo", "波"),
    ];
    const rows: AggregateRow[] = [
      makeRow("k_zhong", [makeVod()]),
      makeRow("k_an", [makeVod()]),
      makeRow("k_bo", [makeVod()]),
    ];
    const result = collectSourceOptions(rows, keyword, sites);
    expect(result.map((r) => r.siteName)).toEqual(["安", "波", "中"]);
    expect(result.map((r) => r.siteKey)).toEqual(["k_an", "k_bo", "k_zhong"]);
  });

  it("站点名缺失时回退到 row.siteKey", () => {
    const rows: AggregateRow[] = [
      makeRow("raw_key", [makeVod()]),
      makeRow("blank_name", [makeVod()]),
    ];
    const sites: SourceSite[] = [makeSite("blank_name", "")];
    const result = collectSourceOptions(rows, keyword, sites);
    expect(result.find((r) => r.siteKey === "raw_key")?.siteName).toBe("raw_key");
    expect(result.find((r) => r.siteKey === "blank_name")?.siteName).toBe("blank_name");
  });
});

describe("episodeNumber", () => {
  it("取剧集名里第一个数字：第01集→1、EP 12→12", () => {
    expect(episodeNumber("第01集")).toBe(1);
    expect(episodeNumber("EP 12")).toBe(12);
  });

  it("无数字或空值返回 null", () => {
    expect(episodeNumber("预告片")).toBeNull();
    expect(episodeNumber("")).toBeNull();
    expect(episodeNumber(null)).toBeNull();
    expect(episodeNumber(undefined)).toBeNull();
  });
});

describe("pickMatchingEpisode", () => {
  it("同名精确优先，即使另一条线路排更前", () => {
    const lines: PlayLine[] = makeLines([
      { name: "线路甲", episodes: ["第1集", "2"] },
      { name: "线路乙", episodes: ["第01集", "第02集"] },
    ]);
    const result = pickMatchingEpisode(lines, { name: "第02集", index: 0 });
    expect(result?.episode.name).toBe("第02集");
    expect(result?.line.name).toBe("线路乙");
    expect(result?.index).toBe(1);
  });

  it("同名不存在时按集号匹配（第02集 → 2）", () => {
    const lines: PlayLine[] = makeLines([
      { name: "线路甲", episodes: ["第1集", "2", "第3集"] },
    ]);
    const result = pickMatchingEpisode(lines, { name: "第02集" });
    expect(result?.episode.name).toBe("2");
    expect(result?.index).toBe(1);
  });

  it("都不命中时按 current.index 取，index 为线路内序号", () => {
    const lines: PlayLine[] = makeLines([
      { name: "线路甲", episodes: ["第1集", "第2集"] },
      { name: "线路乙", episodes: ["第3集"] },
    ]);
    const result = pickMatchingEpisode(lines, { name: "剧场版", index: 1 });
    expect(result?.line.name).toBe("线路甲");
    expect(result?.episode.name).toBe("第2集");
    expect(result?.index).toBe(1);
  });

  it("current.index 越界时钳制到末条/首条", () => {
    const lines: PlayLine[] = makeLines([
      { name: "线路甲", episodes: ["第1集", "第2集"] },
      { name: "线路乙", episodes: ["第3集"] },
    ]);
    const last = pickMatchingEpisode(lines, { name: "剧场版", index: 99 });
    expect(last?.line.name).toBe("线路乙");
    expect(last?.episode.name).toBe("第3集");
    expect(last?.index).toBe(0);
    expect(pickMatchingEpisode(lines, { name: "剧场版", index: -5 })?.episode.name).toBe("第1集");
  });

  it("lines 为空或所有线路无剧集时返回 null", () => {
    expect(pickMatchingEpisode([], { name: "第1集", index: 0 })).toBeNull();
    expect(
      pickMatchingEpisode(makeLines([{ name: "空线路", episodes: [] }]), { name: "第1集" }),
    ).toBeNull();
  });

  it("返回对象含 line / episode / index，且引用自入参", () => {
    const lines: PlayLine[] = makeLines([
      { name: "线路甲", episodes: ["第1集"] },
      { name: "线路乙", episodes: ["第2集", "第3集"] },
    ]);
    const result = pickMatchingEpisode(lines, { name: "第3集" });
    expect(result?.line).toBe(lines[1]);
    expect(result?.episode).toBe(lines[1].episodes[1]);
    expect(result?.index).toBe(1);
  });
});

describe("countEpisodes", () => {
  it("多线路剧集数求和", () => {
    const lines: PlayLine[] = makeLines([
      { name: "线路甲", episodes: ["第1集", "第2集", "第3集"] },
      { name: "线路乙", episodes: ["第4集", "第5集"] },
    ]);
    expect(countEpisodes(lines)).toBe(5);
  });

  it("空数组或空线路为 0", () => {
    expect(countEpisodes([])).toBe(0);
    expect(countEpisodes(makeLines([{ name: "空线路", episodes: [] }]))).toBe(0);
  });
});
