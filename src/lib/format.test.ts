import { describe, expect, it } from "vitest";
import {
  canFailover,
  formatDuration,
  parseEpisodes,
  parsePlayLines,
  splitFlag,
  toVodRef,
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
