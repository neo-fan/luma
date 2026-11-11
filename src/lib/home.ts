import type { HomeResult } from "../types/tvbox";

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
export function mergeHomeFallback(base: HomeResult, fallback: HomeResult | null): HomeResult {
  if (!fallback) {
    return base;
  }
  return {
    classes: base.classes?.length ? base.classes : (fallback.classes ?? []),
    filters: base.filters ?? fallback.filters,
    list: (base.list ?? []).length ? base.list : (fallback.list ?? []),
  };
}
