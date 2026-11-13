import Icon from "./Icon";

interface PlayButtonProps {
  label: string;
  onPlay: () => void;
  /** 已看进度百分比（0-100）；不传则不渲染进度环。 */
  percent?: number;
  /** 按钮直径（px），默认 64。 */
  size?: number;
}

/**
 * 收藏 / 历史卡片中央的圆形播放按钮。
 * - 包裹层与海报同尺寸（aspect-ratio:2/3）且 pointer-events:none，只让按钮本身
 *   可点，不挡卡片其它区域（点海报别处仍走卡片自身的详情跳转）。
 * - percent 传入时，描边是一圈进度环：灰底轨=总时长，高亮弧=已看进度（历史页）。
 */
export default function PlayButton({ label, onPlay, percent, size = 64 }: PlayButtonProps) {
  const R = 21;
  const circumference = 2 * Math.PI * R;
  return (
    <div className="fav-play-wrap">
      <button
        type="button"
        className="fav-play"
        title={label}
        aria-label={label}
        style={{ width: size, height: size }}
        onClick={onPlay}
      >
        {typeof percent === "number" ? (
          <svg className="fav-play__ring" viewBox="0 0 48 48" aria-hidden="true">
            <circle className="fav-play__track" cx="24" cy="24" r={R} />
            <circle
              className="fav-play__progress"
              cx="24"
              cy="24"
              r={R}
              style={{ strokeDasharray: `${(circumference * percent) / 100} ${circumference}` }}
            />
          </svg>
        ) : null}
        <span className="fav-play__icon">
          <Icon name="play" />
        </span>
      </button>
    </div>
  );
}
