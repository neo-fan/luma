/**
 * 操作类图标：与侧栏 NavIcon 同一个开源图标库（Lucide）与同一组几何参数，
 * 见 `./icons`。保留 `IconName` 语义名，让调用方只描述「做什么」而不是
 * 「画哪条 path」——换图标时改一行映射即可。
 *
 * 图标按钮**没有文案**，所以调用方必须给 `label`（IconButton 会写成
 * aria-label + 悬浮提示）。这也是探针唯一的定位手段，别用位置猜。
 */
import {
  ArrowDownUp,
  ArrowLeftRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Globe,
  Pencil,
  Play,
  RotateCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ICON_PROPS } from "./icons";

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
  | "globe"
  | "pencil";

const ICONS: Record<IconName, LucideIcon> = {
  back: ChevronLeft,
  next: ChevronRight,
  refresh: RotateCw,
  /** 双箭头互换：换源 / 换线路共用，比「⇄」字符在任何字体下都稳定 */
  swap: ArrowLeftRight,
  external: ExternalLink,
  /** 上下双箭头：倒序开关。激活态整体 scaleY(-1)，方向即是状态，不换图标。 */
  sort: ArrowDownUp,
  chevron: ChevronDown,
  close: X,
  trash: Trash2,
  copy: Copy,
  check: Check,
  play: Play,
  search: Search,
  /** 搜索页「全部站点」：globe 比文字更贴合图标语言，且避免原生 select 风格突兀。 */
  globe: Globe,
  pencil: Pencil,
};

export default function Icon({
  name,
  size,
  className,
}: {
  name: IconName;
  /** 边长（px）。不传沿用 Lucide 默认 24，与既有调用保持一致。 */
  size?: number;
  className?: string;
}) {
  const Glyph = ICONS[name];
  return (
    <Glyph {...ICON_PROPS} {...(size ? { size } : null)} className={className} />
  );
}
