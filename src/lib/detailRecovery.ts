/**
 * 空详情的按片名自愈：从同一站点的搜索结果里挑一个可信的同名候选。
 *
 * TVBox 的 `vod_id` 只在**产生它的那个源、那一次搜索**里有效：配置刷新、
 * 源站换库、跨源换源时拿旧 id 调 `detailContent`，源站通常不报错，只回一个
 * 空 `list`，前端于是只剩「未获取到影片详情」。这时按片名重新问一次本站，
 * 用新 id 再拉详情，是宿主层能做的通用兜底（不需要认识任何具体源）。
 */
import { rankByTitle, titleMatchScore } from "./format";
import type { VodInfo } from "../types/tvbox";

/** 只允许精确片名或片名包含关键词；弱相关会把用户送到另一部片子上。 */
export const MIN_RECOVERY_SCORE = 2;

export function pickRecoveryCandidate(
  list: readonly VodInfo[] | null | undefined,
  title: string,
  originalId: string,
): VodInfo | null {
  const keyword = title.trim();
  if (!keyword || !Array.isArray(list) || list.length === 0) {
    return null;
  }
  const ranked = rankByTitle([...list], keyword, (item) => item?.vod_name);
  for (const item of ranked) {
    if (!item?.vod_id || titleMatchScore(item.vod_name, keyword) < MIN_RECOVERY_SCORE) {
      continue;
    }
    // 同一个 id 已经拉过空详情，再试一次没有意义。
    if (String(item.vod_id) === String(originalId)) {
      continue;
    }
    return item;
  }
  return null;
}
