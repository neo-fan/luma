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
 * 没有 React 渲染入口，所以这里导出一份 SVG 字符串。
 *
 * ⚠️ 这两个**不能**复用上面的 Lucide 描边风格（2026-11-14 用户反馈「我们加的
 * 按钮和原生的不搭」）。ArtPlayer 内置图标是 22px、纯填充、path 不写 fill，
 * 由 `.art-video-player svg{fill:var(--art-font-color)}` 统一上色；旁边放一个
 * 1.75 描边 + 透明填充的线框图标，视觉上轻一档，还多一圈外描边，一眼就能看出
 * 是后加的。因此这里按内置几何自绘填充路径，尺寸也跟内置的 22 对齐。
 */
export const PLAYER_NEXT_ICON = [
  // 外层 `.art-icon` 与内置控件结构一致：ArtPlayer 用它套 36px 容器与缩放，
  // 里面 22px 的 svg 才不会被拉成 40×40 的巨图标。
  '<i class="art-icon">',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22"',
  'width="22" height="22" aria-hidden="true" focusable="false">',
  // 三角直接沿用内置 play 的路径（同一套 2px 圆角），缩到 0.65 左移，
  // 右侧补一根圆角竖条 —— 与「暂停」并排时圆角半径、填充重量完全一致。
  '<path transform="translate(1.3 3.87) scale(0.65)" d="M17.982 9.275L8.06 3.27A2.013 2.013 0 0 0 5 4.994v12.011a2.017 2.017 0 0 0 3.06 1.725l9.922-6.005a2.017 2.017 0 0 0 0-3.45z"/>',
  '<rect x="14.8" y="4.4" width="2.2" height="13.2" rx="1.05"/>',
  "</svg></i>",
].join(" ");

/**
 * 控制栏「刷新」：Material `refresh` 的填充路径（24 网格、22px 显示，
 * 与内置 check 图标同样是「viewBox 24 + width 22」的混用做法）。
 */
export const PLAYER_RELOAD_ICON = [
  '<i class="art-icon">',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"',
  'width="22" height="22" aria-hidden="true" focusable="false">',
  '<path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>',
  "</svg></i>",
].join(" ");
