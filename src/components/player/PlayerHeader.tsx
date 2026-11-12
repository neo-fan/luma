import FavStar from "../FavStar";

interface PlayerHeaderProps {
  vodName: string;
  episodeName: string;
  progressLabel: string;
  onBack: () => void;
  /**
   * 收藏状态。`null` 表示当前条目不可收藏（直播频道没有 vod 条目），
   * 此时不渲染按钮；`undefined` 视为未收藏。
   */
  favorite?: boolean | null;
  favBusy?: boolean;
  onToggleFavorite?: () => void;
}

/**
 * 播放页顶部：返回详情、片名（含收藏星）、播放进度。
 * 片源与线路信息挪到播放器下方的信息卡里，这里只留最常用的两件事。
 * 收藏是单图标按钮，紧贴片名右侧——放右侧工具栏会离标题太远。
 * 纯展示，DOM 契约（`.page-head` / `.page-title__sub`）不可改。
 */
export default function PlayerHeader({
  vodName,
  episodeName,
  progressLabel,
  onBack,
  favorite,
  favBusy = false,
  onToggleFavorite,
}: PlayerHeaderProps) {
  return (
    <header className="page-head">
      <div className="page-head__main">
        <button type="button" className="btn btn--ghost" onClick={onBack}>
          ← 返回详情
        </button>
        <h1 className="page-title">
          <span className="page-title__name">{vodName || "播放"}</span>
          {favorite === null || !onToggleFavorite ? null : (
            <FavStar on={favorite === true} busy={favBusy} onToggle={onToggleFavorite} />
          )}
          <span className="page-title__sub">{episodeName}</span>
        </h1>
      </div>
      <div className="player-head__meta">
        <span className="page-meta">{progressLabel}</span>
      </div>
    </header>
  );
}
