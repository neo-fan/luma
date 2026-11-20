import { describe, expect, it } from "vitest";
import {
  activeOptionV,
  buildExtend,
  extendCacheSuffix,
  filterDefsFor,
  type FilterDef,
} from "./categoryFilters";

/** 豆瓣[py] 的 movie 筛选定义（截取，含「全部」空串选项）。 */
const MOVIE_DEFS: FilterDef[] = [
  {
    key: "类型",
    name: "类型",
    value: [
      { n: "全部类型", v: "" },
      { n: "喜剧", v: "喜剧" },
      { n: "动作", v: "动作" },
    ],
  },
  {
    key: "sort",
    name: "排序",
    value: [
      { n: "近期热度", v: "T" },
      { n: "首映时间", v: "R" },
    ],
  },
];

describe("filterDefsFor", () => {
  it("取出当前分类的筛选定义", () => {
    const defs = filterDefsFor({ movie: MOVIE_DEFS }, "movie");
    expect(defs).toEqual(MOVIE_DEFS);
  });

  it("其它分类 / 缺失 / 非对象都返回空数组", () => {
    expect(filterDefsFor({ movie: MOVIE_DEFS }, "tv")).toEqual([]);
    expect(filterDefsFor(null, "movie")).toEqual([]);
    expect(filterDefsFor(undefined, "movie")).toEqual([]);
    // 社区脚本可能给出烂结构：挡掉而不是渲染崩溃。
    expect(filterDefsFor({ movie: "oops" }, "movie")).toEqual([]);
    expect(filterDefsFor({ movie: [null, 3] }, "movie")).toEqual([]);
    expect(filterDefsFor({ movie: [{ key: "k", value: "x" }] }, "movie")).toEqual([]);
    expect(filterDefsFor({ movie: [{ key: "", value: [{ n: "a", v: "b" }] }] }, "movie")).toEqual([]);
    // 选项缺 n / v / 非对象逐个丢弃。
    expect(
      filterDefsFor(
        { movie: [{ key: "k", value: [{ n: "a" }, { v: "b" }, "x", { n: "c", v: "d" }] }] },
        "movie",
      ),
    ).toEqual([{ key: "k", name: "k", value: [{ n: "c", v: "d" }] }]);
    // name 缺失回退 key。
    expect(
      filterDefsFor({ movie: [{ key: "sort", value: [{ n: "T", v: "T" }] }] }, "movie"),
    ).toEqual([{ key: "sort", name: "sort", value: [{ n: "T", v: "T" }] }]);
  });
});

describe("buildExtend", () => {
  it("收集非空选中值", () => {
    expect(buildExtend(MOVIE_DEFS, { 类型: "喜剧", sort: "R" })).toEqual({
      类型: "喜剧",
      sort: "R",
    });
  });

  it("空串（全部）与未选一样省略", () => {
    expect(buildExtend(MOVIE_DEFS, { 类型: "", sort: "R" })).toEqual({ sort: "R" });
    expect(buildExtend(MOVIE_DEFS, {})).toEqual({});
  });

  it("选中残留的 key 不在 defs 里时不外发", () => {
    expect(buildExtend(MOVIE_DEFS, { ghost: "x", 类型: "喜剧" })).toEqual({ 类型: "喜剧" });
  });
});

describe("activeOptionV", () => {
  it("未选时高亮「全部」（v=\"\"）选项", () => {
    expect(activeOptionV(MOVIE_DEFS[0], {})).toBe("");
    expect(activeOptionV(MOVIE_DEFS[0], { 类型: "" })).toBe("");
  });

  it("选中值直接回显", () => {
    expect(activeOptionV(MOVIE_DEFS[0], { 类型: "动作" })).toBe("动作");
  });

  it("没有「全部」选项且未选时不高亮任何项", () => {
    expect(activeOptionV(MOVIE_DEFS[1], {})).toBe("__none__");
  });
});

describe("extendCacheSuffix", () => {
  it("键排序稳定，与点选顺序无关", () => {
    expect(extendCacheSuffix({ 类型: "喜剧", sort: "R" })).toBe("sort=R&类型=喜剧");
    expect(extendCacheSuffix({ sort: "R", 类型: "喜剧" })).toBe("sort=R&类型=喜剧");
  });

  it("空 extend 返回空串，缓存键退回无筛选形态", () => {
    expect(extendCacheSuffix({})).toBe("");
  });
});
