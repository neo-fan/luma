/**
 * 操作类线性图标（与侧栏 NavIcon 同一套几何语言：24×24 viewBox、1.7 描边、
 * `currentColor`、圆头圆角）。
 *
 * 为什么单独一份而不是全塞进 NavIcon：侧栏图标是「导航语义」，这里的是
 * 「操作语义」，两者会各自长（侧栏会加分类/发现，工具栏会加投屏/下载），
 * 合在一起改一处要连带回归另一处。几何参数必须保持一致，肉眼看不出接缝。
 *
 * 图标按钮**没有文案**，所以调用方必须给 `label`（IconButton 会写成
 * aria-label + 悬浮提示）。这也是探针唯一的定位手段，别用位置猜。
 */
import type { ReactNode } from "react";

export type IconName =
  | "back"
  | "next"
  | "refresh"
  | "swap"
  | "external"
  | "sort"
  | "chevron"
  | "close"
  | "trash"
  | "copy"
  | "check"
  | "play"
  | "search"
  | "pencil";

const PATHS: Record<IconName, ReactNode> = {
  back: <path d="m14.6 5.5-6.6 6.5 6.6 6.5" />,
  next: <path d="m9.4 5.5 6.6 6.5-6.6 6.5" />,
  /* 双箭头互换：换源 / 换线路共用，比「⇄」字符在任何字体下都稳定 */
  swap: (
    <>
      <path d="M4 8.5h13.5" />
      <path d="m14.2 5.2 3.3 3.3-3.3 3.3" />
      <path d="M20 15.5H6.5" />
      <path d="m9.8 12.2-3.3 3.3 3.3 3.3" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.6 12a7.6 7.6 0 1 1-2.4-5.5" />
      <path d="M19.9 4.6v4.8h-4.8" />
    </>
  ),
  external: (
    <>
      <path d="M13.8 3.8h6.4v6.4" />
      <path d="m20.2 3.8-8.4 8.4" />
      <path d="M18.4 14.2v4.6a1.4 1.4 0 0 1-1.4 1.4H5.2a1.4 1.4 0 0 1-1.4-1.4V7a1.4 1.4 0 0 1 1.4-1.4h4.6" />
    </>
  ),
  /* 上下双箭头：倒序开关。激活态整体 scaleY(-1)，方向即是状态，不换图标。 */
  sort: (
    <>
      <path d="M7 4.8v14.4" />
      <path d="m3.9 8 3.1-3.2L10.1 8" />
      <path d="M17 19.2V4.8" />
      <path d="m13.9 16 3.1 3.2 3.1-3.2" />
    </>
  ),
  chevron: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  close: <path d="m6.2 6.2 11.6 11.6M17.8 6.2 6.2 17.8" />,
  trash: (
    <>
      <path d="M4.2 7h15.6" />
      <path d="M9.4 7V5.4A1.4 1.4 0 0 1 10.8 4h2.4a1.4 1.4 0 0 1 1.4 1.4V7" />
      <path d="m6.6 7 .8 12.1A1.5 1.5 0 0 0 8.9 20.5h6.2a1.5 1.5 0 0 0 1.5-1.4L17.4 7" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="10.8" height="10.8" rx="2" />
      <path d="M15.2 5.6A1.6 1.6 0 0 0 13.6 4H5.6A1.6 1.6 0 0 0 4 5.6v8a1.6 1.6 0 0 0 1.6 1.6" />
    </>
  ),
  check: <path d="m5 12.6 4.4 4.4L19 7.4" />,
  play: <path d="M8.4 5.3 18 12l-9.6 6.7z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.2" />
      <path d="m15.6 15.6 4 4" />
    </>
  ),
  pencil: (
    <>
      <path d="M4.5 19.5h3.2L19 8.2a1.6 1.6 0 0 0 0-2.3l-1-1a1.6 1.6 0 0 0-2.3 0L4.5 16.3z" />
      <path d="m14.4 6.2 3.4 3.4" />
    </>
  ),
};

export default function Icon({ name }: { name: IconName }) {
  return (
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
      {PATHS[name]}
    </svg>
  );
}
