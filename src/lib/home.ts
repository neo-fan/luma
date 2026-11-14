import type { HomeResult } from "../types/tvbox";

/**
 * TVBox 协议里 `homeContent` 的分类字段叫 `class`，而本项目的内部契约叫
 * `classes`（py 适配层已经做过一次映射，quickjs 源是**原样透传**）。少了
 * 这一步，JS 源首页的分类 chip 会一片空白（只剩一个「暂无分类」），用户看到
 * 的就是「这个源什么都没有」。JS 源里 `class` / `classes` 两种写法都有，
 * 所以两个都认，`classes` 优先。
 */
export function normalizeHomeResult(raw: unknown): HomeResult {
  const box = (raw ?? {}) as Record<string, unknown>;
  const classes = Array.isArray(box.classes)
    ? (box.classes as HomeResult["classes"])
    : Array.isArray(box.class)
      ? (box.class as HomeResult["classes"])
      : [];
  return {
    classes,
    filters: (box.filters as HomeResult["filters"]) ?? null,
    list: Array.isArray(box.list) ? (box.list as HomeResult["list"]) : [],
  };
}

/**
 * 合并首页分类与推荐流（纯函数，便于单测；不依赖任何 IPC / Tauri runtime）。
 *
 * TVBox 协议把两者分开：`homeContent` 给 `classes`（+ 有些源顺带在 list 里
 * 放首屏），`homeVideoContent` 专给推荐 `list`。严格按协议分家的源（如豆瓣）
 * `homeContent` 只有分类，必须再问一次 `homeVideoContent` 才有卡片。
 *
 * 合并规则（一律 base 优先，fallback 只补 base 真正缺的东西）：
 *   - list：base 非空优先（尊重源自己的首屏排序），否则用 fallback 的；
 *   - classes：base 非空优先，否则补 fallback 的；
 *   - filters：**只用 base**。`{}` 是合法的「无筛选」终态，而 fallback
 *     （homeVideoContent）经归一后常带空壳/重复 filters，绝不能用它覆盖
 *     homeContent 的筛选定义；仅当 base.filters 为 null/undefined 时才借。
 *
 * fallback 为 null（兜底调用失败/源不支持）时原样返回 base，绝不让首页报错。
 */
export function mergeHomeFallback(
  rawBase: HomeResult | null | undefined,
  rawFallback: HomeResult | null | undefined,
): HomeResult {
  const base = normalizeHomeResult(rawBase);
  if (!rawFallback) {
    return base;
  }
  const fallback = normalizeHomeResult(rawFallback);
  return {
    classes: base.classes.length ? base.classes : fallback.classes,
    filters: base.filters ?? fallback.filters,
    list: base.list.length ? base.list : fallback.list,
  };
}
