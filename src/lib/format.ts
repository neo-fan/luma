/**
 * 播放字段解析与展示格式化（纯函数，无副作用）。
 *
 * TVBox 约定：
 *   vod_play_from  线路名，`$$$` 分隔
 *   vod_play_url   剧集，`名称$地址#名称$地址`，线路之间 `$$$` 分隔
 * 任何空串、缺字段一律返回空数组，不抛异常。
 */
import type { VodInfo, VodRef } from "../types/tvbox";

/** 单集：显示名 + 播放地址 */
export interface Episode {
  name: string;
  url: string;
}

/** 单条线路及其剧集 */
export interface PlayLine {
  name: string;
  episodes: Episode[];
}

/** `$$$` 切片，去掉空白段。 */
export function splitFlag(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split("$$$")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * `名称$地址#名称$地址` → 剧集数组。
 * 没有 `$` 的段落当作纯地址，名称按序号补齐；没有地址的段落丢弃。
 */
export function parseEpisodes(raw: string | null | undefined): Episode[] {
  if (!raw) {
    return [];
  }
  const episodes: Episode[] = [];
  raw.split("#").forEach((chunk, index) => {
    const text = chunk.trim();
    if (!text) {
      return;
    }
    const cut = text.indexOf("$");
    const rawName = cut >= 0 ? text.slice(0, cut).trim() : "";
    const url = cut >= 0 ? text.slice(cut + 1).trim() : text;
    if (!url) {
      return;
    }
    episodes.push({ name: rawName || `第 ${index + 1} 集`, url });
  });
  return episodes;
}

/** `vod_play_from` + `vod_play_url` → 线路数组；无剧集的线路跳过。 */
export function parsePlayLines(
  from: string | null | undefined,
  url: string | null | undefined,
): PlayLine[] {
  const names = splitFlag(from);
  const groups = (url ?? "").split("$$$");
  const total = Math.max(names.length, groups.length);
  const lines: PlayLine[] = [];
  for (let index = 0; index < total; index += 1) {
    const episodes = parseEpisodes(groups[index]);
    if (episodes.length === 0) {
      continue;
    }
    const name = names[index]?.trim() || `线路 ${index + 1}`;
    lines.push({ name, episodes });
  }
  return lines;
}

/** 毫秒 → `mm:ss` 或 `h:mm:ss`。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "00:00";
  }
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/** VodInfo → 收藏 / 历史所需的 VodRef。 */
export function toVodRef(
  siteKey: string,
  siteName: string | undefined,
  vod: VodInfo,
): VodRef {
  return {
    siteKey,
    vodId: String(vod.vod_id),
    name: vod.vod_name,
    pic: vod.vod_pic || undefined,
    remarks: vod.vod_remarks || undefined,
    siteName,
  };
}
