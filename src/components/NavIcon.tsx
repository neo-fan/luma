/**
 * 侧边栏导航图标：全部映射到 Lucide，几何参数见 `./icons`。
 *
 * 保留 `NavIconName` 与默认导出的调用契约（App.tsx 按 `item.key` 取值），
 * 换库不需要动任何调用点。收缩态只显示图标，所以都选了 19px 下仍可辨的
 * 单色线性图；`settings` 用齿轮（Settings），不再是原来那个「太阳」。
 */
import {
  ChevronsLeft,
  History,
  House,
  Play,
  Search,
  Settings,
  Star,
  Tv,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ICON_PROPS } from "./icons";

export type NavIconName =
  | "home"
  | "live"
  | "player"
  | "search"
  | "favorites"
  | "history"
  | "settings"
  /** 收起/展开共用一枚：收缩态由 CSS 整体旋转 180°，方向连续翻转更顺。 */
  | "collapse";

const ICONS: Record<NavIconName, LucideIcon> = {
  home: House,
  live: Tv,
  player: Play,
  search: Search,
  favorites: Star,
  history: History,
  settings: Settings,
  collapse: ChevronsLeft,
};

export default function NavIcon({ name }: { name: NavIconName }) {
  const Glyph = ICONS[name];
  return <Glyph {...ICON_PROPS} />;
}
