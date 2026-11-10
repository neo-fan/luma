/**
 * 手动换源共享逻辑：详情页与播放页复用。
 *
 * TVBox 里「换源」是显式选择一个不同的站点；自动换源（PlayerPage 的
 * tryFailover）只在播放失败时按后端顺序探测。这里把「找候选」和「跨源
 * 保持当前集」抽成纯函数 + 一次聚合 IPC，避免两处各写一套搜索规则。
 */
import { titleMatchScore } from "./format";
import type { Episode, PlayLine } from "./format";
import { api } from "./invoke";
import type { ResultPage, Site } from "../types/tvbox";

/** `spider_invoke({ siteKey: "all" })` 返回的单站结果行。 */
export interface AggregateRow {
  siteKey: string;
  ok: boolean;
  data?: ResultPage;
  error?: { code?: string; message?: string };
}

export interface AggregateResult {
  results?: AggregateRow[];
  ok?: number;
  failed?: number;
  skipped?: number;
  total?: number;
  tookMs?: number;
}

/** 一个可切换的片源：站点 + 该站里的影片条目。 */
export interface SourceOption {
  siteKey: string;
  siteName: string;
  runtime?: Site["runtime"];
  vodId: string;
  vodName: string;
  remarks?: string;
  pic?: string;
  /** 片名相关度 0..3，见 titleMatchScore。 */
  matchScore: number;
}

export interface SourceSearchStats {
  /** 实际参与检索的站点数（后端报告值，缺失时用前端可用站点数兜底）。 */
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  tookMs: number;
  /** 片名相关度 >= 2 的候选数。 */
  matched: number;
}

export const EMPTY_SOURCE_STATS: SourceSearchStats = {
  total: 0,
  ok: 0,
  failed: 0,
  skipped: 0,
  tookMs: 0,
  matched: 0,
};

/** 站点在候选列表里展示所需的字段子集；单测构造更轻。 */
export type SourceSite = Pick<Site, "key" | "name" | "runtime" | "enabled">;

/**
 * 聚合结果 → 每站一条最佳候选。
 *
 * 真实配置里的坑：部分站点无匹配时返回整页推荐，另一些做单字模糊匹配。
 * 因此按 titleMatchScore 过滤，并只保留每站得分最高的条目；不删除站点，
 * 由 UI 决定要不要展示相关度 1 的弱匹配。
 */
export function collectSourceOptions(
  rows: AggregateRow[] | undefined,
  keyword: string,
  sites: SourceSite[],
  excludeSiteKey?: string,
  minScore = 1,
): SourceOption[] {
  const byKey = new Map(sites.map((site) => [site.key, site]));
  const best = new Map<string, SourceOption>();

  for (const row of rows ?? []) {
    if (!row.ok || !row.data?.list?.length) {
      continue;
    }
    if (excludeSiteKey && row.siteKey === excludeSiteKey) {
      continue;
    }
    const site = byKey.get(row.siteKey);
    // 运行配置已屏蔽 jar / JS 源；后端不会返回它们，这里再兜一层。
    if (site && (!site.enabled || site.runtime === "jvm" || site.runtime === "quickjs")) {
      continue;
    }
    for (const vod of row.data.list) {
      if (!vod.vod_id || !vod.vod_name) {
        continue;
      }
      const score = titleMatchScore(vod.vod_name, keyword);
      if (score < minScore) {
        continue;
      }
      const previous = best.get(row.siteKey);
      if (previous && previous.matchScore >= score) {
        continue;
      }
      best.set(row.siteKey, {
        siteKey: row.siteKey,
        siteName: site?.name || row.siteKey,
        runtime: site?.runtime,
        vodId: String(vod.vod_id),
        vodName: vod.vod_name,
        remarks: vod.vod_remarks || undefined,
        pic: vod.vod_pic || undefined,
        matchScore: score,
      });
    }
  }

  return [...best.values()].sort(
    (a, b) => b.matchScore - a.matchScore || a.siteName.localeCompare(b.siteName, "zh-CN"),
  );
}

/** 一次 IPC 并发检索全部启用站点；墙钟与搜索页一致，短了会只剩几个慢源。 */
export async function searchSources(
  keyword: string,
  sites: Site[],
  excludeSiteKey: string,
  timeoutMs = 20_000,
): Promise<{ options: SourceOption[]; stats: SourceSearchStats }> {
  const word = keyword.trim();
  const eligible = sites.filter(
    (site) => site.enabled && site.runtime !== "jvm" && site.runtime !== "quickjs",
  );
  if (!word || eligible.length === 0) {
    return { options: [], stats: { ...EMPTY_SOURCE_STATS } };
  }

  const agg = (await api.spiderInvoke({
    siteKey: "all",
    method: "searchContent",
    args: [word, false, 1],
    timeoutMs,
  })) as AggregateResult;

  const options = collectSourceOptions(agg.results, word, sites, excludeSiteKey);
  return {
    options,
    stats: {
      total: agg.total ?? eligible.length,
      ok: agg.ok ?? eligible.length,
      failed: agg.failed ?? 0,
      skipped: agg.skipped ?? 0,
      tookMs: agg.tookMs ?? 0,
      matched: options.filter((item) => item.matchScore >= 2).length,
    },
  };
}

/** 剧集名里的第一个阿拉伯数字；「第01集」「1」「EP 01」都归一成 1。 */
export function episodeNumber(name: string | null | undefined): number | null {
  const match = String(name ?? "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

export interface MatchedEpisode {
  line: PlayLine;
  episode: Episode;
  /** 在该线路内的序号。 */
  index: number;
}

/**
 * 换源后尽量续播同一集：同名 → 同集号 → 同序号 → 第一条。
 * 找不到任何剧集时返回 null，由调用方提示「该源没有可播放剧集」。
 */
export function pickMatchingEpisode(
  lines: PlayLine[],
  current: { name?: string; index?: number },
): MatchedEpisode | null {
  const all = lines.flatMap((line) =>
    line.episodes.map((episode, index) => ({ line, episode, index })),
  );
  if (all.length === 0) {
    return null;
  }

  const name = current.name?.trim();
  if (name) {
    const exact = all.find((item) => item.episode.name.trim() === name);
    if (exact) {
      return exact;
    }
    const number = episodeNumber(name);
    if (number !== null) {
      const byNumber = all.find((item) => episodeNumber(item.episode.name) === number);
      if (byNumber) {
        return byNumber;
      }
    }
  }
  const index = Math.min(Math.max(current.index ?? 0, 0), all.length - 1);
  return all[index];
}

/** 所有线路的剧集总数；用于详情页「共 N 集」。 */
export function countEpisodes(lines: PlayLine[]): number {
  return lines.reduce((total, line) => total + line.episodes.length, 0);
}
