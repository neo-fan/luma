/**
 * 历史条目的纯展示逻辑（历史页卡片副标题）。
 *
 * 播放页写入的 `playFrom` / `episodeName` 是「上次从哪条线路看到第几集」的
 * 唯一来源；换过源后线路名和剧集地址都会变，历史列表必须把它们显示出来，
 * 用户才能判断要不要继续这条线路。抽成纯函数便于单测。
 */
import type { HistoryItem } from "../types/luma";

/** 播放进度：拿不到时长时只显示已看时长。 */
export function progressText(item: Pick<HistoryItem, "positionMs" | "durationMs">): string {
  const position = item.positionMs ?? 0;
  if (!item.durationMs || item.durationMs <= 0) {
    return position > 0 ? `已看 ${Math.round(position / 1000)} 秒` : "";
  }
  const percent = Math.min(99, Math.round((position / item.durationMs) * 100));
  return `已看 ${percent}%`;
}

/** 相对时间：历史列表里「3 小时前」比一串 ISO 更好扫。 */
export function relativeTime(ms: number, now = Date.now()): string {
  if (!ms) {
    return "";
  }
  const diff = now - ms;
  if (diff < 60_000) {
    return "刚刚";
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)} 分钟前`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)} 小时前`;
  }
  if (diff < 7 * 86_400_000) {
    return `${Math.floor(diff / 86_400_000)} 天前`;
  }
  const date = new Date(ms);
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 卡片副标题：线路 · 集数 · 站点 · 进度 · 时间（空字段自动省略）。
 *
 * 线路与集数排在最前：卡片宽度有限且 `text-overflow: ellipsis`，站点/时间被截
 * 不影响「上次从哪条线看到第几集」这个核心信息。
 */
export function historySubtitle(item: HistoryItem, now = Date.now()): string {
  return [
    item.playFrom ? `线路 ${item.playFrom}` : "",
    item.episodeName ? `看到 ${item.episodeName}` : "",
    item.siteName || item.siteKey,
    progressText(item),
    relativeTime(item.updatedAt, now),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * 卡片封面上的信息行（历史页）：第一行「集数 · 进度」，第二行「线路 · 时间」。
 *
 * 历史页的卡片标题下不再放副标题 —— 五段信息挤在一行里既读不过来，也把片名
 * 挤成两截。封面底部本来就是视觉冗余区（海报底部多为纯色），压两行小字既不
 * 挡关键画面，又让「看到第几集、看了多少、哪条线、多久前」一眼可读。
 * 副本 `historySubtitle` 仍作为 hover 提示保留完整信息（含站点名）。
 */
export function historyCoverMeta(item: HistoryItem, now = Date.now()): string[] {
  const progress = progressText(item);
  const first = [item.episodeName, progress].filter(Boolean).join(" · ");
  const second = [item.playFrom || item.siteName || item.siteKey, relativeTime(item.updatedAt, now)]
    .filter(Boolean)
    .join(" · ");
  return [first, second].filter(Boolean);
}
