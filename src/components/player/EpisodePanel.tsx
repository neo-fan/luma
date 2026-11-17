import { useMemo, useState } from "react";
import EpisodeButton from "../EpisodeButton";
import IconButton from "../IconButton";
import type { PlayLine } from "../../lib/format";

interface EpisodePanelProps {
  lines: PlayLine[];
  panelLine: number;
  lineIndex: number;
  episodeIndex: number;
  /** 已请求、还没落地的集：那一格显示排队态，不代表正在播放。 */
  pendingPick?: { lineIndex: number; episodeIndex: number } | null;
  setPanelLine: (value: number) => void;
  goToEpisode: (targetLine: number, index: number) => void;
}

/** 长剧集才值得给筛选框，短剧多一个输入框纯属噪音。 */
const FILTER_AT = 24;

/**
 * 选集区（常驻在播放器下方）：线路 chip 切换 + 全剧集直达。
 * 索引始终指向**原始**剧集数组，筛选/倒序只影响展示顺序。
 */
export default function EpisodePanel({
  lines,
  panelLine,
  lineIndex,
  episodeIndex,
  pendingPick = null,
  setPanelLine,
  goToEpisode,
}: EpisodePanelProps) {
  const [query, setQuery] = useState("");
  const [reverse, setReverse] = useState(false);

  const episodes = lines[panelLine]?.episodes ?? [];
  // 当前**正在播放**的集名：切线路时用它在新线路里找同名集。
  const episodeName = lines[lineIndex]?.episodes[episodeIndex]?.name ?? "";
  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const indexed = episodes
      .map((episode, index) => ({ episode, index }))
      .filter(({ episode }) => !keyword || episode.name.toLowerCase().includes(keyword));
    return reverse ? indexed.reverse() : indexed;
  }, [episodes, query, reverse]);

  return (
    <section className="player-episodes">
      <div className="section-head">
        <h2 className="section-title">选集</h2>
        <span className="page-meta">
          {/* 集数只按当前线路统计：各线路是独立剧集表，跨线路累加（160 集）
              没有意义，用户要的是「这条线路有多少集」。 */}
          {lines.length} 条线路 · 当前线路 {episodes.length} 集
        </span>
      </div>

      <div className="chip-row">
        {lines.map((item, index) => (
          <button
            key={`${item.name}-${index}`}
            type="button"
            className={index === panelLine ? "chip is-active" : "chip"}
            // 点线路 = 真的切线路（不是只切下方的集数面板）：视频卡住 / 没出画
            // 时用户最需要换线路，而控制栏里的 selector 要等播放器实例建好才有。
            // 目标集优先取同名集，源换了集名就退回该线路第 1 集。
            onClick={() => {
              if (index === panelLine && index === lineIndex) {
                return;
              }
              setPanelLine(index);
              const sameName = episodeName
                ? item.episodes.findIndex((episode) => episode.name === episodeName)
                : -1;
              goToEpisode(index, sameName >= 0 ? sameName : 0);
            }}
            title={`切换到 ${item.name}（${item.episodes.length} 集）`}
          >
            {item.name}（{item.episodes.length}）
          </button>
        ))}
      </div>

      {episodes.length > FILTER_AT ? (
        <div className="player-episodes__tools">
          <input
            className="input"
            type="text"
            value={query}
            placeholder="筛选集数（如 12、第2季）"
            aria-label="筛选剧集"
            onChange={(event) => setQuery(event.target.value)}
          />
          <IconButton
            name="sort"
            label={reverse ? "正序" : "倒序"}
            pressed={reverse}
            className="icon-btn--flip"
            onClick={() => setReverse((v) => !v)}
          />
          <span className="page-meta">显示 {visible.length} 集</span>
        </div>
      ) : null}

      <div className="episode-grid">
        {visible.map(({ episode, index }) => {
          const active = panelLine === lineIndex && index === episodeIndex;
          const pending = 
            !active &&
            pendingPick !== null &&
            pendingPick.lineIndex === panelLine &&
            pendingPick.episodeIndex === index;
          return (
            <EpisodeButton
              key={`${episode.url}-${index}`}
              name={episode.name}
              active={active}
              pending={pending}
              onClick={() => goToEpisode(panelLine, index)}
            />
          );
        })}
      </div>

      {visible.length === 0 ? (
        <p className="tip player-episodes__empty">没有匹配的集数</p>
      ) : null}
    </section>
  );
}
