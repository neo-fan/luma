import { describe, expect, it } from "vitest";
import { mergeMeta } from "./coverMeta";
import type { HistoryItem } from "../types/luma";

const base: HistoryItem = {
  siteKey: "cms",
  vodId: "108142",
  name: "庆余年第一季",
  pic: "",
  remarks: "",
  siteName: "360",
  updatedAt: 1_700_000_000_000,
};

describe("mergeMeta", () => {
  it("fills the cover that the row was missing", () => {
    const next = mergeMeta(base, {
      siteKey: "cms",
      vodId: "108142",
      name: "庆余年第一季",
      pic: "https://img.example/1.jpg",
      remarks: "全46集",
    });
    expect(next.pic).toBe("https://img.example/1.jpg");
    expect(next.remarks).toBe("全46集");
    // 回填不能动进度、线路、时间这些播放状态。
    expect(next.updatedAt).toBe(base.updatedAt);
    expect(next.siteName).toBe("360");
  });

  it("keeps existing fields when the patch is blank", () => {
    const seeded: HistoryItem = {
      ...base,
      pic: "https://img.example/old.jpg",
      remarks: "HD",
      siteName: "360",
      episodeName: "第02集",
      playFrom: "360zy",
    };
    const next = mergeMeta(seeded, {
      siteKey: "cms",
      vodId: "108142",
      name: "",
      pic: "",
      remarks: "",
      siteName: "",
    });
    expect(next).toEqual(seeded);
  });

  it("does not mutate the original row", () => {
    const next = mergeMeta(base, { ...base, pic: "https://img.example/x.jpg" });
    expect(next).not.toBe(base);
    expect(base.pic).toBe("");
  });
});
