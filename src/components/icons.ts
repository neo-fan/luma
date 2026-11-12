/**
 * 全站图标基线：统一走 [Lucide](https://lucide.dev)（ISC 开源，24×24 视口、
 * 圆头圆角、`currentColor`）。侧栏、工具栏、收藏星都从这里取同一组几何参数，
 * 不再各自手写 path。
 *
 * 之前手绘图标的毛病：描边/留白各差一点，甚至 `settings` 画成了「太阳 + 圆」，
 * 用户一眼就认不出是设置。换库后语义与形状都由同一套图标保证；要微调粗细
 * 只改这里的 `strokeWidth`，所有入口一起变。
 */
import type { SVGProps } from "react";

/** Lucide 默认 2 略粗，1.75 在 15~22px 的小尺寸下更接近原来的观感。 */
export const ICON_STROKE_WIDTH = 1.75;

/** 图标是装饰性图形：语义由按钮的 aria-label 承担，svg 本身不进无障碍树。 */
export const ICON_PROPS: SVGProps<SVGSVGElement> = {
  strokeWidth: ICON_STROKE_WIDTH,
  "aria-hidden": true,
  focusable: "false",
};
