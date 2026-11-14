import { describe, expect, it } from "vitest";
import { leafClasses } from "./categories";

describe("leafClasses", () => {
  it("drops CMS parent categories that have children", () => {
    const classes = [
      { type_id: "1", type_name: "电影", type_pid: 0 },
      { type_id: "2", type_name: "连续剧", type_pid: 0 },
      { type_id: "6", type_name: "动作片", type_pid: 1 },
      { type_id: "7", type_name: "喜剧片", type_pid: "1" },
      { type_id: "20", type_name: "国产剧", type_pid: 2 },
    ];
    expect(leafClasses(classes)).toEqual([
      { type_id: "6", type_name: "动作片", parentName: "电影" },
      { type_id: "7", type_name: "喜剧片", parentName: "电影" },
      { type_id: "20", type_name: "国产剧", parentName: "连续剧" },
    ]);
  });

  it("keeps every class when no parent/child metadata exists (py/js sources)", () => {
    const classes = [
      { type_id: "hot_gaia", type_name: "热门电影" },
      { type_id: "tv_hot", type_name: "热播剧集" },
    ];
    expect(leafClasses(classes).map((c) => c.type_id)).toEqual(["hot_gaia", "tv_hot"]);
  });

  it("keeps top-level classes when their children are not listed", () => {
    expect(leafClasses([{ type_id: "1", type_name: "电影" }])).toEqual([
      { type_id: "1", type_name: "电影" },
    ]);
  });

  it("normalizes numeric ids and ignores empty entries", () => {
    const result = leafClasses([
      { type_id: 1 as unknown as string, type_name: "父", type_pid: 0 },
      { type_id: 6 as unknown as string, type_name: "子", type_pid: 1 },
      { type_id: "", type_name: "空" },
    ]);
    expect(result).toEqual([{ type_id: "6", type_name: "子", parentName: "父" }]);
  });

  it("de-duplicates repeated classes while keeping source order", () => {
    // 直播转点播这类 js 源会把同一批分类返回两遍，chip 行不该整排重复。
    const classes = [
      { type_id: "a", type_name: "A" },
      { type_id: "b", type_name: "B" },
      { type_id: "a", type_name: "A" },
    ];
    expect(leafClasses(classes).map((c) => c.type_id)).toEqual(["a", "b"]);
  });
});
