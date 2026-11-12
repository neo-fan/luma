/**
 * 历史条目的纯展示逻辑（历史页卡片副标题）。
 *
 * 播放页写入的 `playFrom` / `episodeName` 是「上次从哪条线路看到第几集」的
 * 唯一来源；换过源后线路名和剧集地址都会变，历史列表必须把它们显示出来，
 * 用户才能判断要不要继续这条线路。抽成纯函数便于单测。
 */
import type { HistoryItem } from "../types/tvbox";

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

/** 卡片副标题：站点 · 线路 · 集数 · 进度 · 时间（空字段自动省略）。 */
export function historySubtitle(item: HistoryItem, now = Date.now()): string {
  return [
    item.siteName || item.siteKey,
    item.playFrom ? `线路 ${item.playFrom}` : "",
    item.episodeName ? `看到 ${item.episodeName}` : "",
    progressText(item),
    relativeTime(item.updatedAt, now),
  ]
    .filter(Boolean)
    .join(" · ");
}
