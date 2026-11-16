/**
 * 剧集列表编排（从 PlayerPage 抽出，拉取 effect 体与依赖数组保持原样）。
 *
 * 拉详情只为拿剧集列表做上/下集与选集；直播没有剧集概念，短路掉必败请求。
 * 拿到列表后按 playUrl 定位当前 line/episode 索引，供播放条的「第 N / M 集」
 * 与自动下一集使用。失败一律回退空列表，不影响当前播放。
 *
 * 首帧直出：换集会重挂载整页（播放实例必须重建），而详情已在 数据缓存 里
 * （10 分钟 TTL、零 IPC）。这里用同步 `peek` 做首帧种子，避免信息卡先闪成
 * 「无封面」、选集面板先消失再长出来——2026-11-14 用户反馈的「点下一集底下
 * 全刷新」。命中种子就不发请求，没命中才走原来的异步路径。
 */
import { useEffect, useState } from "react";
import { api, cacheKeys } from "../lib/invoke";
import { CACHE_TTL, peekFresh } from "../lib/queryClient";
import { parsePlayLines } from "../lib/format";
import type { PlayLine } from "../lib/format";
import {
  locateEpisode,
  seedFromCachedDetail,
  type EpisodeSeed,
} from "../lib/episodeSeed";
import type { VodInfo } from "../types/luma";

export interface EpisodeList {
  lines: PlayLine[];
  lineIndex: number;
  episodeIndex: number;
  panelLine: number;
  setPanelLine: (value: number) => void;
  currentLine: PlayLine | null;
  canPrev: boolean;
  canNext: boolean;
  /** 详情原始条目：播放页的收藏按钮要 pic / remarks 才能存成完整收藏项。 */
  vod: VodInfo | null;
}

/** 首帧种子只算一次；直播与空详情都返回 null，走异步路径。 */
function readSeed(
  siteKey: string,
  vodId: string,
  playUrl: string,
  episodeName: string,
  playFrom: string,
): EpisodeSeed | null {
  if (siteKey === "live" || !vodId.trim()) {
    return null;
  }
  const cached = peekFresh<VodInfo[]>(cacheKeys.detail(siteKey, vodId), CACHE_TTL.detail);
  return seedFromCachedDetail(cached, playUrl, episodeName, playFrom);
}

export function useEpisodeList(
  siteKey: string,
  vodId: string,
  playUrl: string,
  /** 路由里的集名 / 线路名：地址失配时用它们兜底定位。 */
  episodeName = "",
  playFrom = "",
): EpisodeList {
  const [seed] = useState(() => readSeed(siteKey, vodId, playUrl, episodeName, playFrom));
  const [lines, setLines] = useState<PlayLine[]>(seed?.lines ?? []);
  const [vod, setVod] = useState<VodInfo | null>(seed?.vod ?? null);
  const [lineIndex, setLineIndex] = useState(seed?.locus.line ?? 0);
  const [episodeIndex, setEpisodeIndex] = useState(seed?.locus.episode ?? 0);
  const [panelLine, setPanelLine] = useState(seed?.locus.line ?? 0);

  // 拉详情只为拿剧集列表做上/下集，失败不影响当前播放。
  useEffect(() => {
    // 直播没有剧集概念，去拿 detailContent 只会多一次必败请求。
    if (siteKey === "live") {
      setLines([]);
      setVod(null);
      return;
    }
    // 首帧已由 数据缓存 直出：这份详情就是同一份缓存，无需再读一次。
    if (seed) {
      return;
    }
    let alive = true;
    const run = async () => {
      try {
        const list = await api.detail(siteKey, vodId);
        if (!alive) {
          return;
        }
        const first = list && list.length > 0 ? list[0] : null;
        setVod(first);
        setLines(first ? parsePlayLines(first.vod_play_from, first.vod_play_url) : []);
      } catch {
        if (alive) {
          setLines([]);
          setVod(null);
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
    // seed 是挂载时的快照，不参与依赖：命中后这份详情不会再变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, vodId]);

  // 定位当前线路/集：先按地址精确匹配；地址对不上（源轮换了 CDN，很常见）
  // 再按「同线路名 + 同集名」兜底，否则播放页会显示成第 1 集第 1 条线路，
  // 上/下一集也跟着错位。线路名优先取路由里的 playFrom（用户点的那条）。
  useEffect(() => {
    const locus = locateEpisode(lines, playUrl, episodeName, playFrom);
    setLineIndex(locus.line);
    setPanelLine(locus.line);
    setEpisodeIndex(locus.episode);
  }, [lines, playUrl, episodeName, playFrom]);

  const currentLine = lines[lineIndex] ?? null;
  const canPrev = currentLine !== null && episodeIndex > 0;
  const canNext = currentLine !== null && episodeIndex < currentLine.episodes.length - 1;

  return {
    lines,
    lineIndex,
    episodeIndex,
    panelLine,
    setPanelLine,
    currentLine,
    canPrev,
    canNext,
    vod,
  };
}
