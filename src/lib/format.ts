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

/**
 * TVBox 的 `vod_content` / 演员字段常混着 `<p>` `<br/>` 这类 HTML 片段。
 * 详情页与播放页都是纯文本展示，直接渲染会把标签当正文吐出来。
 * 这里只做「换行标签转换 + 去标签 + 解常见实体 + 收敛空行」，不引解析器。
 */
export function plainText(input: string | undefined): string {
  if (!input) {
    return "";
  }
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

/**
 * TVBox `changeable: 0` 表示该源明确不允许换源。
 *
 * 自动换源会对其它站点发起搜索与探测，对声明了不可换源的源既不尊重配置，
 * 也白白多打一轮请求。字段缺失时按「允许」处理（老配置没有这个字段）。
 */
export function canFailover(site?: { changeable?: boolean }): boolean {
  return site?.changeable !== false;
}

/**
 * 首页/分类等需要向站点发请求的视图里，真正可运行的站点。
 *
 * 屏蔽规则与后端 `derive_runtime` 一致：客户端已实现 QuickJS ESM 加载器与
 * drpy2 依赖，js 源可正常执行；只剩 jvm（Android dex/jar）源导入时会被标
 * `enabled=false`+`disabledReason`。这里再按 runtime 兜一层，兼容旧缓存里
 * 仍写着 enabled=true 的屏蔽源。App 选默认站、首页自动顺延都走这一份口径，
 * 避免两处过滤条件漂移。
 */
export function usableHomeSites<T extends object>(sites: T[]): T[] {
  return sites.filter((site) => {
    const item = site as { runtime?: string; enabled?: boolean; disabledReason?: string };
    return item.enabled !== false && item.runtime !== "jvm" && !item.disabledReason;
  });
}

/**
 * 聚合搜索的片名相关度（0..3），只用于展示排序。
 *
 * 真实配置里踩过的坑：部分站点无匹配时不返回空列表，而是回退整页推荐；
 * 另一些站点做单字模糊匹配。于是搜「嫁金钗」会混进 86 条无关短剧和大量
 * 「三嫁公主 / 彼岸之嫁」，真正命中的 20+ 条被淹没在后面。这里**不删除**
 * 任何结果，避免误伤「嫁金钗 田曦薇」这类带演员后缀的合法片名。
 *
 * 归一化只做小写 + 去空白/常见分隔符；不做繁简或同义词转换。
 *   3 完全相等 · 2 片名包含完整关键词 · 1 命中过半关键字 · 0 不相关
 */
/**
 * 片名归一：去空白与常见标点、统一小写。搜索词、详情页片名、缓存键都用
 * 同一套规则，否则「庆余年 第二季」与「庆余年第二季」会被当成两部片。
 */
export function normalizeTitle(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\s:：·・\-—_.,，。!！?？\[\]【】()（）]/g, "");
}

export function titleMatchScore(
  name: string | null | undefined,
  keyword: string,
): number {
  const title = normalizeTitle(name);
  const key = normalizeTitle(keyword);
  if (!title || !key) {
    return 0;
  }
  if (title === key) {
    return 3;
  }
  if (title.includes(key)) {
    return 2;
  }
  // 逐字覆盖仅在过半命中时给分：只沾一个「嫁」字的片名不算相关。
  const chars = [...new Set([...key])];
  const covered = chars.filter((char) => title.includes(char)).length;
  return covered * 2 >= chars.length ? 1 : 0;
}

/**
 * 按片名相关度稳定排序，返回新数组（不修改入参）。同分保持后端返回顺序，
 * 因此同一站点内部的结果次序不会被打乱。
 */
export function rankByTitle<T>(
  items: T[],
  keyword: string,
  titleOf: (item: T) => string | null | undefined,
): T[] {
  if (!keyword.trim() || items.length < 2) {
    return items.slice();
  }
  return items
    .map((item, index) => ({
      item,
      index,
      score: titleMatchScore(titleOf(item), keyword),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}
