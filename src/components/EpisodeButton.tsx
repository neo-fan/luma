import { useCallback, useRef } from "react";

interface EpisodeButtonProps {
  name: string;
  /** 上次看到的这一集：右上角绿点，完整文案在 title 里。 */
  seen?: boolean;
  /** 当前集：右上角状态点。暂停时也成立，所以文案用「当前集」而不是「正在播放」。 */
  active?: boolean;
  /** 已请求但还没切换成功：排队态，与 active 互斥优先由调用方保证。 */
  pending?: boolean;
  onClick: () => void;
}

/**
 * 选集格子。
 *
 * 竖屏短剧 / 综艺的集名经常是「20260515特别企划」这种 10+ 字，格子宽度固定，
 * 单行必然裁切、折两行又会让整行网格高低不齐。所以：默认单行裁切，指针悬停
 * 或键盘聚焦时把内容横向滚到末尾，让整个集名露出来；移开 / 失焦再回位。
 */
export default function EpisodeButton({
  name,
  seen = false,
  active = false,
  pending = false,
  onClick,
}: EpisodeButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);

  const scrollToEnd = useCallback(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow > 1) {
      // 减弱动效时降级为瞬时定位：平滑滚动不在全局动画降级覆盖范围内。
      const options: ScrollToOptions = { left: overflow, behavior: "smooth" };
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        options.behavior = "auto";
      }
      el.scrollTo(options);
    }
  }, []);

  const reset = useCallback(() => {
    const el = ref.current;
    if (el && el.scrollLeft > 0) {
      const options: ScrollToOptions = { left: 0, behavior: "smooth" };
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        options.behavior = "auto";
      }
      el.scrollTo(options);
    }
  }, []);

  const className = [
    "episode",
    seen ? "is-seen" : "",
    active ? "is-active" : "",
    pending ? "is-pending" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      ref={ref}
      type="button"
      className={className}
      onClick={onClick}
      aria-busy={pending || undefined}
      onPointerEnter={scrollToEnd}
      onPointerLeave={reset}
      onFocus={scrollToEnd}
      onBlur={reset}
      title={pending ? `${name}（排队中）` : seen ? `${name}（上次看到）` : name}
    >
      {name}
      {pending ? (
        <span className="episode__pending">
          <span className="sr-only">排队中</span>
        </span>
      ) : active ? (
        <span className="episode__now">
          <span className="sr-only">当前集</span>
        </span>
      ) : null}
    </button>
  );
}
