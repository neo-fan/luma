import { useMemo, useState } from "react";
import { countEpisodes } from "../../lib/sources";
import type { PlayLine } from "../../lib/format";

interface EpisodePanelProps {
  lines: PlayLine[];
  panelLine: number;
  lineIndex: number;
  episodeIndex: number;
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
  setPanelLine,
  goToEpisode,
}: EpisodePanelProps) {
  const [query, setQuery] = useState("");
  const [reverse, setReverse] = useState(false);

  const episodes = lines[panelLine]?.episodes ?? [];
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
          共 {lines.length} 条线路 · {countEpisodes(lines)} 集
        </span>
      </div>

      <div className="chip-row">
        {lines.map((item, index) => (
          <button
            key={`${item.name}-${index}`}
            type="button"
            className={index === panelLine ? "chip is-active" : "chip"}
            onClick={() => setPanelLine(index)}
            title={`${item.episodes.length} 集`}
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
          <button type="button" className="btn btn--sm" onClick={() => setReverse((v) => !v)}>
            {reverse ? "正序" : "倒序"}
          </button>
          <span className="page-meta">显示 {visible.length} 集</span>
        </div>
      ) : null}

      <div className="episode-grid">
        {visible.map(({ episode, index }) => {
          const active = panelLine === lineIndex && index === episodeIndex;
          return (
            <button
              key={`${episode.url}-${index}`}
              type="button"
              className={active ? "episode is-active" : "episode"}
              onClick={() => goToEpisode(panelLine, index)}
              title={episode.name}
            >
              {episode.name}
              {active ? <span className="episode__now">正在播放</span> : null}
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <p className="tip player-episodes__empty">没有匹配的集数</p>
      ) : null}
    </section>
  );
}
