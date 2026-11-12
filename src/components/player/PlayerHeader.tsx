interface PlayerHeaderProps {
  vodName: string;
  episodeName: string;
  siteKey: string;
  siteName?: string;
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

/** 播放页顶部：返回详情、片名/集数、当前源与播放进度。纯展示，DOM 契约不可改。 */
export default function PlayerHeader({
  vodName,
  episodeName,
  siteKey,
  siteName,
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
          {vodName || "播放"}
          <span className="page-title__sub">{episodeName}</span>
        </h1>
      </div>
      <div className="player-head__meta">
        <span className="detail-source" title={siteKey}>
          当前源：{siteName || siteKey}
        </span>
        <span className="page-meta">{progressLabel}</span>
        {favorite === null || !onToggleFavorite ? null : (
          <button
            type="button"
            className={favorite ? "btn btn--fav is-on" : "btn btn--fav"}
            onClick={onToggleFavorite}
            disabled={favBusy}
            title={favorite ? "取消收藏" : "加入收藏"}
          >
            {favorite ? "★ 已收藏" : "☆ 收藏"}
          </button>
        )}
      </div>
    </header>
  );
}
