import type { HomeResult } from "../types/luma";

/**
 * TVBox 筛选面板（`homeContent(filter=true)` 返回的 `filters`）的纯函数层。
 *
 * 协议形状（py/js 源原样透传，CMS 源没有）：
 *   filters: { [type_id]: [{ key, name, value: [{ n, v }] }] }
 * 选中状态是 `{ [filterKey]: 选项v }`；未选的 key 不进 extend——豆瓣这类源
 * 对空值有自己的默认语义（`extend.get("sort") or "T"`），把「全部」的空串
 * 塞进去反而可能覆盖掉源的默认排序。
 */

export interface FilterOption {
  /** 展示名（「喜剧」「全部地区」）。 */
  n: string;
  /** 传给 categoryContent extend 的值（空串=全部）。 */
  v: string;
}

export interface FilterDef {
  key: string;
  name: string;
  value: FilterOption[];
}

export type FilterMap = NonNullable<HomeResult["filters"]>;

/**
 * 取当前分类的筛选定义。源数据来自社区脚本，形状不可信：非对象、缺
 * `value` 数组、选项缺 n/v 都要挡掉，坏条目丢弃而不是让渲染崩溃。
 * 入参按 unknown 收（py/js 源原样透传，形状没有编译期保证）。
 */
export function filterDefsFor(filters: unknown, tid: string): FilterDef[] {
  if (!filters || typeof filters !== "object") {
    return [];
  }
  const raw = (filters as Record<string, unknown>)[tid];
  if (!Array.isArray(raw)) {
    return [];
  }
  const defs: FilterDef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const box = item as Record<string, unknown>;
    const key = typeof box.key === "string" ? box.key : "";
    const name = typeof box.name === "string" ? box.name : key;
    if (!key || !Array.isArray(box.value)) {
      continue;
    }
    const options = (box.value as unknown[]).filter(
      (option): option is FilterOption =>
        Boolean(option) &&
        typeof option === "object" &&
        typeof (option as FilterOption).v === "string" &&
        typeof (option as FilterOption).n === "string",
    );
    if (options.length > 0) {
      defs.push({ key, name, value: options });
    }
  }
  return defs;
}

/**
 * 由选中状态构造 categoryContent 的 extend：
 * - 只收 defs 里声明过的 key（选中残留比声明晚到时别把脏值发给源）；
 * - 空串（「全部」）与未选一样省略——把空串发出去会覆盖源的默认行为
 *   （豆瓣 `sort` 缺省 T；`tags` 空串虽无害，但统一省略最干净）。
 */
export function buildExtend(
  defs: FilterDef[],
  selection: Record<string, string>,
): Record<string, string> {
  const extend: Record<string, string> = {};
  for (const def of defs) {
    const picked = selection[def.key];
    if (typeof picked === "string" && picked !== "") {
      extend[def.key] = picked;
    }
  }
  return extend;
}

/**
 * 选中状态的「活性」判定：用户没选过时，把第一个 v="" 的选项（TVBox 惯例
 * 的「全部」）当默认高亮，UI 上不出现没有任何高亮行的裸筛选组。
 */
export function activeOptionV(def: FilterDef, selection: Record<string, string>): string {
  const picked = selection[def.key];
  if (typeof picked === "string" && picked !== "") {
    return picked;
  }
  const allDefault = def.value.find((option) => option.v === "");
  return allDefault ? "" : "__none__";
}

/**
 * extend 的稳定缓存键后缀：键排序后 `k=v` 用 `&` 连接。同一组条件无论
 * 用户以什么顺序点选，缓存都命中同一条；无筛选时返回空串（键退回旧形态）。
 */
export function extendCacheSuffix(extend: Record<string, string>): string {
  const parts = Object.keys(extend)
    .sort()
    .map((key) => `${key}=${extend[key]}`);
  return parts.length > 0 ? parts.join("&") : "";
}
