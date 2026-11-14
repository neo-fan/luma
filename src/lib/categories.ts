/**
 * 分类 chip 的筛选：CMS `ac=list` 把父子两级都塞进 `class[]`，但很多采集站
 * 的 `ac=videolist&t=<父级 id>` **永远返回空列表**（实测 360 / 非凡的 t=1/2/3
 * 都是 `list:[] total:0`，只有 t=6「动作片」这类叶子分类才带真实 pagecount）。
 *
 * 把这些「有子分类的父级」从 chip 行里去掉，用户才不会点进一个永远为空、
 * 分页也永远禁用的类目。py/js 源的 classes 没有 type_pid，全部原样保留。
 */
import type { CategoryClass } from "../types/tvbox";

export interface DisplayClass {
  type_id: string;
  type_name: string;
  /** 有父级时给 chip 的 hover 提示用，例如「电影 / 动作片」。 */
  parentName?: string;
}

export function leafClasses(
  classes: readonly CategoryClass[] | null | undefined,
): DisplayClass[] {
  const items = (classes ?? []).filter((item) => item && String(item.type_id ?? "") !== "");
  const byId = new Map<string, string>();
  for (const item of items) {
    byId.set(String(item.type_id), String(item.type_name ?? ""));
  }
  // 只要某个 id 被别的分类当成 type_pid，它就是父级。
  const parentIds = new Set(
    items
      .map((item) => String(item.type_pid ?? ""))
      .filter((pid) => pid !== "" && pid !== "0"),
  );
  return items
    .filter((item) => !parentIds.has(String(item.type_id)))
    .map((item) => {
      const pid = String(item.type_pid ?? "");
      const parentName = pid && pid !== "0" ? byId.get(pid) : undefined;
      return {
        type_id: String(item.type_id),
        type_name: String(item.type_name ?? ""),
        ...(parentName ? { parentName } : {}),
      };
    })
    // 有些 js 源（直播转点播这类）把同一批分类重复返回两遍，chip 行会整排
    // 重复。按 type_id 去重，保留第一次出现的顺序。
    .filter((item, index, all) => all.findIndex((other) => other.type_id === item.type_id) === index);
}
