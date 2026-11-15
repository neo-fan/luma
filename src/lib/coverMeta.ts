/** 收藏 / 历史条目的封面合并规则（纯函数，便于单测）。 */
import type { VodRef } from "../types/luma";

/**
 * 把回填到的字段合并进列表项：**只覆盖非空值**。
 * 补封面时详情可能只带回封面，备注/站点名要保留列表里已有的那份。
 */
export function mergeMeta<T extends VodRef>(item: T, patch: VodRef): T {
  return {
    ...item,
    name: patch.name || item.name,
    pic: patch.pic || item.pic,
    remarks: patch.remarks || item.remarks,
    siteName: patch.siteName || item.siteName,
  };
}
