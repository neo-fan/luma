/**
 * 剧集列表编排（从 PlayerPage 抽出，两个 effect 体与依赖数组保持原样）。
 *
 * 拉详情只为拿剧集列表做上/下集与选集；直播没有剧集概念，短路掉必败请求。
 * 拿到列表后按 playUrl 定位当前 line/episode 索引，供播放条的「第 N / M 集」
 * 与自动下一集使用。失败一律回退空列表，不影响当前播放。
 */
import { useEffect, useState } from "react";
import { api } from "../lib/invoke";
import { parsePlayLines } from "../lib/format";
import type { PlayLine } from "../lib/format";
import type { VodInfo } from "../types/tvbox";

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

export function useEpisodeList(siteKey: string, vodId: string, playUrl: string): EpisodeList {
  const [lines, setLines] = useState<PlayLine[]>([]);
  const [vod, setVod] = useState<VodInfo | null>(null);
  const [lineIndex, setLineIndex] = useState(0);
  const [episodeIndex, setEpisodeIndex] = useState(0);
  const [panelLine, setPanelLine] = useState(0);

  // 拉详情只为拿剧集列表做上/下集，失败不影响当前播放。
  useEffect(() => {
    // 直播没有剧集概念，去拿 detailContent 只会多一次必败请求。
    if (siteKey === "live") {
      setLines([]);
      setVod(null);
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
  }, [siteKey, vodId]);

  useEffect(() => {
    for (let line = 0; line < lines.length; line += 1) {
      const index = lines[line].episodes.findIndex((item) => item.url === playUrl);
      if (index >= 0) {
        setLineIndex(line);
        setPanelLine(line);
        setEpisodeIndex(index);
        return;
      }
    }
    setLineIndex(0);
    setPanelLine(0);
    setEpisodeIndex(0);
  }, [lines, playUrl]);

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
