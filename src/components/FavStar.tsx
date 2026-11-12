/**
 * 收藏星（纯图标按钮）。
 *
 * 只靠「描边 → 实心金色」表达状态，不写文字；因此可访问性必须自带
 * `aria-label` / `aria-pressed`。探针也按 `aria-pressed` 判断状态——
 * 图标按钮没有 `textContent`，按文案断言的旧写法会全红。
 */
interface FavStarProps {
  on: boolean;
  busy?: boolean;
  onToggle: () => void;
}

export default function FavStar({ on, busy = false, onToggle }: FavStarProps) {
  const label = on ? "取消收藏" : "加入收藏";
  return (
    <button
      type="button"
      className={on ? "fav-star is-on" : "fav-star"}
      onClick={onToggle}
      disabled={busy}
      aria-pressed={on}
      aria-label={label}
      title={label}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {/* 外半径 10 / 内半径 4.3，星形占满 24 视口的约 79%。旧路径只占
            65%，即使把 svg 放大，肉眼仍觉得「图标小」——这是根因，别只调 CSS 尺寸。 */}
        <path d="M12 2 14.5 8.5 21.5 8.9 16.1 13.3 17.9 20.1 12 16.3 6.1 20.1 7.9 13.3 2.5 8.9 9.5 8.5Z" />
      </svg>
    </button>
  );
}
