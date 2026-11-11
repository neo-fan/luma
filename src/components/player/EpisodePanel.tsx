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

/** 选集面板：线路 chip 切换 + 全剧集直达；当前集高亮由 lineIndex/episodeIndex 决定。 */
export default function EpisodePanel({
  lines,
  panelLine,
  lineIndex,
  episodeIndex,
  setPanelLine,
  goToEpisode,
}: EpisodePanelProps) {
  return (
    <div className="player-episodes">
      <div className="section-head">
        <h2 className="section-title">选集 · 线路</h2>
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
      <div className="episode-grid">
        {(lines[panelLine]?.episodes ?? []).map((episode, index) => {
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
            </button>
          );
        })}
      </div>
    </div>
  );
}
