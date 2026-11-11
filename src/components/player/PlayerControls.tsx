import type { PlayLine } from "../../lib/format";

interface PlayerControlsProps {
  siteKey: string;
  vodName: string;
  canPrev: boolean;
  canNext: boolean;
  goEpisode: (delta: number) => void;
  currentLine: PlayLine | null;
  episodeIndex: number;
  lineCount: number;
  panelOpen: boolean;
  setPanelOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  setShowSources: (value: boolean) => void;
  playExternal: () => void;
}

/** 播放条：上/下一集、线路与集数、选集/换源/外部播放。文案与按钮被 CDP 探针按名定位。 */
export default function PlayerControls({
  siteKey,
  vodName,
  canPrev,
  canNext,
  goEpisode,
  currentLine,
  episodeIndex,
  lineCount,
  panelOpen,
  setPanelOpen,
  setShowSources,
  playExternal,
}: PlayerControlsProps) {
  return (
    <div className="player-bar">
      {siteKey === "live" ? null : (
        <>
          <button
            type="button"
            className="btn"
            onClick={() => goEpisode(-1)}
            disabled={!canPrev}
          >
            上一集
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => goEpisode(1)}
            disabled={!canNext}
          >
            下一集
          </button>
        </>
      )}
      {siteKey === "live" ? (
        <span className="player-bar__info">直播 · {vodName}</span>
      ) : currentLine ? (
        <span className="player-bar__info">
          {currentLine.name} · 第 {episodeIndex + 1} / {currentLine.episodes.length} 集
        </span>
      ) : (
        <span className="player-bar__info">未获取到剧集列表</span>
      )}
      {siteKey === "live" ? null : (
        <button
          type="button"
          className="btn"
          onClick={() => setPanelOpen((value) => !value)}
          disabled={lineCount === 0}
        >
          {panelOpen ? "收起选集" : "选集"}
        </button>
      )}
      {siteKey === "live" ? null : (
        <button type="button" className="btn" onClick={() => setShowSources(true)}>
          ⇄ 换源
        </button>
      )}
      <button type="button" className="btn btn--primary" onClick={playExternal}>
        外部播放
      </button>
    </div>
  );
}
