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
        <path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.3 7.2 18.9l.9-5.4L4.2 9.7l5.4-.8z" />
      </svg>
    </button>
  );
}
