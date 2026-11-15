import { describe, expect, it } from "vitest";
import { mergeHomeFallback, normalizeHomeResult } from "./home";
import type { HomeResult } from "../types/luma";

/**
 * 模拟 homeContent 的返回：classes/filters 是它的职责，list 可能为空。
 * filters 不设默认值——要测「缺失」就得显式传 undefined，避免默认值 {} 掩盖场景。
 */
const homeContent = (
  classes: { type_id: string; type_name: string }[],
  list: { vod_id: string; vod_name: string }[] = [],
  filters?: Record<string, unknown>,
): HomeResult => ({ classes, list, filters }) as unknown as HomeResult;

/** 模拟 homeVideoContent：协议上只保证 list；归一后可能带空壳 classes/filters。 */
const homeVideo = (
  list: { vod_id: string; vod_name: string }[],
  extras: Partial<HomeResult> = {},
): HomeResult => ({ list, ...extras }) as unknown as HomeResult;

describe("mergeHomeFallback", () => {
  it("Douban case: base has classes but no list -> borrow list, keep base classes", () => {
    const tenClasses = Array.from({ length: 10 }, (_, i) => ({
      type_id: `t${i}`,
      type_name: `分类${i}`,
    }));
    const base = homeContent(tenClasses, []); // homeContent: 10 分类、0 卡片
    const fallback = homeVideo([
      { vod_id: "1", vod_name: "后会友期" },
      { vod_id: "2", vod_name: "谷雨" },
    ]);
    const merged = mergeHomeFallback(base, fallback);
    expect(merged.list.map((v) => v.vod_name)).toEqual(["后会友期", "谷雨"]);
    // 豆瓣的 10 个分类来自 homeContent，不能被兜底结果覆盖。
    expect(merged.classes).toEqual(tenClasses);
  });

  it("base list already populated -> keep it, ignore fallback list", () => {
    const base = homeContent([], [{ vod_id: "a", vod_name: "本源首屏" }]);
    const fallback = homeVideo([{ vod_id: "b", vod_name: "推荐流" }]);
    expect(mergeHomeFallback(base, fallback).list[0].vod_name).toBe("本源首屏");
  });

  it("fallback null (unsupported method) -> keep base content", () => {
    const base = homeContent([], [{ vod_id: "a", vod_name: "本源" }]);
    const merged = mergeHomeFallback(base, null);
    expect(merged.list.map((v) => v.vod_name)).toEqual(["本源"]);
    expect(merged.classes).toEqual([]);
  });

  it("JS source shape: protocol `class` is promoted to `classes`", () => {
    // quickjs 源原样透传 TVBox 协议字段，py 适配层才是 `classes`。
    const jsBase = { class: [{ type_id: "1", type_name: "电影" }], filters: {} } as unknown as HomeResult;
    expect(normalizeHomeResult(jsBase).classes).toEqual([{ type_id: "1", type_name: "电影" }]);
    expect(mergeHomeFallback(jsBase, null).classes).toHaveLength(1);
  });

  it("`classes` wins over `class` when both are present", () => {
    const both = {
      classes: [{ type_id: "a", type_name: "A" }],
      class: [{ type_id: "b", type_name: "B" }],
    } as unknown as HomeResult;
    expect(normalizeHomeResult(both).classes[0].type_id).toBe("a");
  });

  it("base classes empty -> borrow fallback classes defensively", () => {
    const base = homeContent([], []);
    const fallback = homeVideo([], { classes: [{ type_id: "x", type_name: "分类" }] });
    expect(mergeHomeFallback(base, fallback).classes).toEqual([{ type_id: "x", type_name: "分类" }]);
  });

  it("base filters defined (even empty {}) -> never overridden by fallback", () => {
    // {} 是合法的「无筛选」终态；fallback 归一后的 filters 不该覆盖它。
    const base = homeContent([], [], {});
    const fallback = homeVideo([], { filters: { area: ["大陆"] } } as never);
    expect(mergeHomeFallback(base, fallback).filters).toEqual({});
  });

  it("base filters truly missing (undefined) -> borrow fallback filters", () => {
    const base = homeContent([], [], undefined);
    const fallback = homeVideo([], { filters: { area: ["大陆"] } } as never);
    expect(mergeHomeFallback(base, fallback).filters).toEqual({ area: ["大陆"] });
  });

  it("handles partial IPC shape defensively", () => {
    const partial = { list: undefined, classes: undefined } as unknown as HomeResult;
    const fallback = { list: [{ vod_id: "z", vod_name: "z" }] } as unknown as HomeResult;
    const merged = mergeHomeFallback(partial, fallback);
    expect(merged.list).toHaveLength(1);
    expect(merged.classes).toEqual([]);
  });
});
