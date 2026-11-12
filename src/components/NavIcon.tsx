/**
 * 侧边栏线性图标。
 *
 * 统一 24×24 viewBox、1.7 描边、`currentColor`，与 Luma 的简约风格一致；
 * 收缩态只显示图标，所以图形要在 18px 下仍然可辨（避免细碎线条）。
 */
import type { ReactNode } from "react";

export type NavIconName =
  | "home"
  | "live"
  | "search"
  | "favorites"
  | "history"
  | "settings"
  /** 收起/展开共用一枚：收缩态由 CSS 整体旋转 180°，方向连续翻转更顺。 */
  | "collapse";

const PATHS: Record<NavIconName, ReactNode> = {
  home: (
    <>
      <path d="M4 10.6 12 4l8 6.6V19a1 1 0 0 1-1 1h-5v-5.4h-4V20H5a1 1 0 0 1-1-1z" />
    </>
  ),
  live: (
    <>
      <rect x="3" y="6.5" width="18" height="12" rx="2.2" />
      <path d="M10.2 10.4 15 13l-4.8 2.6z" />
      <path d="M8 3.8 12 6l4-2.2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.2" />
      <path d="m15.6 15.6 4 4" />
    </>
  ),
  favorites: (
    <>
      <path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.3 7.2 18.9l.9-5.4L4.2 9.7l5.4-.8z" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 3.2v2.3M12 18.5v2.3M3.2 12h2.3M18.5 12h2.3M5.8 5.8l1.6 1.6M16.6 16.6l1.6 1.6M18.2 5.8l-1.6 1.6M7.4 16.6l-1.6 1.6" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.6V12l3.1 1.9" />
    </>
  ),
  "collapse": <path d="m14.5 6-6 6 6 6" />,
};

export default function NavIcon({ name }: { name: NavIconName }) {
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
