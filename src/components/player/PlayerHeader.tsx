import FavStar from "../FavStar";
import IconButton from "../IconButton";

interface PlayerHeaderProps {
  vodName: string;
  episodeName: string;
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
 * 播放页顶部：返回详情、片名（含收藏星）。
 * 播放进度由 ArtPlayer 控制栏自己显示，顶部不再重复放一份时间文本；
 * 片源与线路信息在下方信息卡里。收藏是单图标按钮，紧贴片名右侧。
 * 纯展示，DOM 契约（`.page-head` / `.page-title__sub`）不可改。
 */
export default function PlayerHeader({
  vodName,
  episodeName,
  onBack,
  favorite,
  favBusy = false,
  onToggleFavorite,
}: PlayerHeaderProps) {
  return (
    <header className="page-head">
      <div className="page-head__main">
        <IconButton name="back" label="返回详情" onClick={onBack} />
        <h1 className="page-title">
          <span className="page-title__name">{vodName || "播放"}</span>
          {favorite === null || !onToggleFavorite ? null : (
            <FavStar on={favorite === true} busy={favBusy} onToggle={onToggleFavorite} />
          )}
          {/* 直播会把频道名同时带在 episodeName 里，与主标题重复；集名与剧名
              相同（或为空）时子标题不渲染，VOD 集名（第 N 集）不受影响。 */}
          {episodeName && episodeName !== vodName ? (
            <span className="page-title__sub">{episodeName}</span>
          ) : null}
        </h1>
      </div>
    </header>
  );
}
