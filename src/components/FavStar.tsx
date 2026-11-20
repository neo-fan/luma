/**
 * 收藏星（纯图标按钮）。
 *
 * 星形改用 Lucide 的 `Star`，与侧栏「收藏」入口、工具栏其它图标同一套几何；
 * 状态仍只靠「描边 → 实心金色」表达，不写文字，因此可访问性必须自带
 * `aria-label` / `aria-pressed`。图标按钮没有 `textContent`，探针据
 * `aria-pressed` 判断状态。
 */
import { useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import { ICON_PROPS } from "./icons";

interface FavStarProps {
  on: boolean;
  busy?: boolean;
  onToggle: () => void;
  /** 额外类名：收藏页把它摆在卡片角上（`.fav-item__unfav`）。 */
  className?: string;
}

export default function FavStar({ on, busy = false, onToggle, className }: FavStarProps) {
  // 「点亮」反馈只在点击瞬间：瞬态 is-pop 挂 250ms 后移除（star-pop 动画
  // 240ms）。不做成 .is-on 常驻动画——收藏页整页 is-on 星挂载会齐刷刷 pop。
  const [popping, setPopping] = useState(false);
  const popTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (popTimer.current !== null) {
        window.clearTimeout(popTimer.current);
      }
    },
    [],
  );

  const handleClick = () => {
    setPopping(true);
    if (popTimer.current !== null) {
      window.clearTimeout(popTimer.current);
    }
    popTimer.current = window.setTimeout(() => setPopping(false), 250);
    onToggle();
  };

  const label = on ? "取消收藏" : "加入收藏";
  return (
    <button
      type="button"
      className={`fav-star${on ? " is-on" : ""}${popping ? " is-pop" : ""}${className ? ` ${className}` : ""}`}
      onClick={handleClick}
      disabled={busy}
      aria-pressed={on}
      aria-label={label}
      title={label}
    >
      {/* Lucide 默认 fill="none"；已收藏态由 CSS 的
          `.fav-star.is-on svg { fill: currentColor }` 覆盖成实心金。 */}
      <Star {...ICON_PROPS} />
    </button>
  );
}
