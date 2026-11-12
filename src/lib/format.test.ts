import { describe, expect, it } from "vitest";
import {
  canFailover,
  formatDuration,
  parseEpisodes,
  parsePlayLines,
  rankByTitle,
  plainText,
  splitFlag,
  titleMatchScore,
  toVodRef,
  usableHomeSites,
} from "./format";

describe("splitFlag", () => {
  it("splits on $$$ and drops empty segments", () => {
    expect(splitFlag("a$$$b$$$")).toEqual(["a", "b"]);
  });

  it("returns empty for nullish input", () => {
    expect(splitFlag(undefined)).toEqual([]);
    expect(splitFlag("")).toEqual([]);
  });
});

describe("parseEpisodes", () => {
  it("parses name$url pairs", () => {
    const episodes = parseEpisodes("第1集$http://a/1.m3u8#第2集$http://a/2.m3u8");
    expect(episodes).toHaveLength(2);
    expect(episodes[1]).toEqual({ name: "第2集", url: "http://a/2.m3u8" });
  });

  it("keeps bare urls and numbers them", () => {
    expect(parseEpisodes("http://a/only.m3u8")).toEqual([
      { name: "第 1 集", url: "http://a/only.m3u8" },
    ]);
  });

  it("drops entries without a url", () => {
    expect(parseEpisodes("第1集$#第2集$http://a/2.m3u8")).toHaveLength(1);
  });
});

describe("parsePlayLines", () => {
  it("aligns lines with their episode groups", () => {
    const lines = parsePlayLines("line1$$$line2", "a$http://a/1#b$http://a/2$$$c$http://a/3");
    expect(lines.map((line) => line.name)).toEqual(["line1", "line2"]);
    expect(lines[1].episodes[0].url).toBe("http://a/3");
  });

  it("skips lines without episodes and fills missing names", () => {
    const lines = parsePlayLines("only", "$$$x$http://a/1");
    expect(lines).toHaveLength(1);
    expect(lines[0].name).toBe("线路 2");
  });

  it("returns empty for missing input", () => {
    expect(parsePlayLines(null, null)).toEqual([]);
  });
});

describe("formatDuration", () => {
  it("formats under an hour as mm:ss", () => {
    expect(formatDuration(65_000)).toBe("01:05");
  });

  it("formats hours as h:mm:ss and guards invalid values", () => {
    expect(formatDuration(3_725_000)).toBe("1:02:05");
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(Number.NaN)).toBe("00:00");
  });
});

describe("toVodRef", () => {
  it("maps optional fields to undefined when blank", () => {
    const ref = toVodRef("stub", "Stub", {
      vod_id: "7",
      vod_name: "Movie",
      vod_pic: "",
      vod_play_from: "",
      vod_play_url: "",
    });
    expect(ref).toMatchObject({ siteKey: "stub", vodId: "7", name: "Movie" });
    expect(ref.pic).toBeUndefined();
  });
});

describe("canFailover", () => {
  it("allows sources that never declared the field", () => {
    expect(canFailover(undefined)).toBe(true);
    expect(canFailover({})).toBe(true);
  });

  it("blocks sources that opted out", () => {
    expect(canFailover({ changeable: false })).toBe(false);
  });

  it("allows sources that explicitly enabled it", () => {
    expect(canFailover({ changeable: true })).toBe(true);
  });
});

describe("usableHomeSites", () => {
  it("keeps enabled cms/python sites and preserves order", () => {
    const sites = [
      { key: "a", runtime: "cms", enabled: true },
      { key: "b", runtime: "python", enabled: true },
      { key: "c", runtime: "cms", enabled: true },
    ];
    expect(usableHomeSites(sites).map((s) => s.key)).toEqual(["a", "b", "c"]);
  });

  it("keeps quickjs sites; drops disabled / jvm / disabledReason sites", () => {
    const sites = [
      { key: "cms", runtime: "cms", enabled: true },
      { key: "off", runtime: "cms", enabled: false },
      { key: "jar", runtime: "jvm", enabled: true },
      { key: "js", runtime: "quickjs", enabled: true },
      { key: "stale", runtime: "jvm", enabled: true, disabledReason: "x" },
      { key: "rejected", runtime: "cms", enabled: true, disabledReason: "x" },
    ];
    expect(usableHomeSites(sites).map((s) => s.key)).toEqual(["cms", "js"]);
  });

  it("treats missing runtime/enabled as usable (old cache compatibility)", () => {
    expect(usableHomeSites([{ key: "legacy" }]).map((s) => s.key)).toEqual(["legacy"]);
  });
});

describe("titleMatchScore", () => {
  const word = "嫁金钗";

  it("ranks an exact title highest", () => {
    expect(titleMatchScore("嫁金钗", word)).toBe(3);
  });

  it("keeps titles containing the whole keyword (suffixes and near-matches)", () => {
    expect(titleMatchScore("嫁金钗田曦薇闫桉", word)).toBe(2);
    expect(titleMatchScore("替嫁金钗", word)).toBe(2);
  });

  it("separates partial-character hits from unrelated recommendations", () => {
    expect(titleMatchScore("金钗谍影", word)).toBe(1);
    expect(titleMatchScore("三嫁公主", word)).toBe(0);
    expect(titleMatchScore("石匠的耳朵", word)).toBe(0);
  });

  it("normalizes whitespace, punctuation and case", () => {
    expect(titleMatchScore("嫁 金钗", word)).toBe(3);
    expect(titleMatchScore("Avengers: Endgame", "avengers endgame")).toBe(3);
  });

  it("returns 0 for a missing title or an empty keyword", () => {
    expect(titleMatchScore(undefined, word)).toBe(0);
    expect(titleMatchScore("嫁金钗", "")).toBe(0);
  });
});

describe("rankByTitle", () => {
  it("moves exact matches to the front without dropping unrelated rows", () => {
    const rows = [
      { name: "三嫁公主" },
      { name: "嫁金钗", tag: "first-exact" },
      { name: "石匠的耳朵" },
      { name: "替嫁金钗" },
      { name: "嫁金钗", tag: "second-exact" },
      { name: "金钗谍影" },
    ];
    const ranked = rankByTitle(rows, "嫁金钗", (row) => row.name);
    expect(ranked.map((row) => row.name)).toEqual([
      "嫁金钗",
      "嫁金钗",
      "替嫁金钗",
      "金钗谍影",
      "三嫁公主",
      "石匠的耳朵",
    ]);
    // Same-score rows stay in the backend order, and the input is untouched.
    expect(ranked.slice(0, 2).map((row) => ("tag" in row ? row.tag : ""))).toEqual([
      "first-exact",
      "second-exact",
    ]);
    expect(rows[0].name).toBe("三嫁公主");
  });

  it("returns a copy in original order for an empty keyword", () => {
    const rows = [{ name: "b" }, { name: "a" }];
    const ranked = rankByTitle(rows, "  ", (row) => row.name);
    expect(ranked.map((row) => row.name)).toEqual(["b", "a"]);
    expect(ranked).not.toBe(rows);
  });
});

describe("plainText", () => {
  it("drops html tags and keeps paragraph breaks", () => {
    expect(plainText("<p>第一段</p><p>第二段<br/>换行</p>")).toBe("第一段\n第二段\n换行");
  });

  it("decodes the entities that show up in CMS content", () => {
    expect(plainText("A&nbsp;&amp;&nbsp;B &lt;剧&gt; &quot;x&quot;")).toBe('A & B <剧> "x"');
  });

  it("collapses the empty-paragraph noise real sources emit", () => {
    expect(plainText("<p>正文</p><p><br/></p><p></p>")).toBe("正文");
    expect(plainText("  \n\n 正文 \n\n\n\n 尾巴 ")).toBe("正文\n\n尾巴");
  });

  it("returns empty string for missing content", () => {
    expect(plainText(undefined)).toBe("");
    expect(plainText("   ")).toBe("");
  });
});
