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

/**
 * ArtPlayer 原生控件专用：它的 `controls[].html` 只接受 HTML 字符串 / DOM 元素，
 * 没有 React 渲染入口，所以这里按 Lucide `skip-forward` 的几何参数导出一份
 * 等价的 SVG 字符串（同一 24×24 视口、currentColor、1.75 描边）。
 * 图标资源仍以 Lucide 为唯一来源，不在调用处各自手画 path。
 */
export const PLAYER_NEXT_ICON = [
  // 外层 `.art-icon` 与内置控件结构一致：ArtPlayer 用它套 36px 容器与缩放，
  // 里面 22px 的 svg 才不会被拉成 40×40 的巨图标。
  '<i class="art-icon">',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"',
  `width="22" height="22" fill="none" stroke="currentColor" stroke-width="${ICON_STROKE_WIDTH}"`,
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">',
  '<path d="M5 4l10 8-10 8V4z"/><path d="M19 5v14"/>',
  "</svg></i>",
].join(" ");

/** 控制栏「刷新」：Lucide `rotate-cw`，同样套 ArtPlayer 的 .art-icon 容器。 */
export const PLAYER_RELOAD_ICON = [
  '<i class="art-icon">',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"',
  `width="22" height="22" fill="none" stroke="currentColor" stroke-width="${ICON_STROKE_WIDTH}"`,
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">',
  '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  "</svg></i>",
].join(" ");
