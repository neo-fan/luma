import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import { ICON_PROPS } from "./icons";

interface EmptyProps {
  title: string;
  description?: string;
  action?: ReactNode;
  /**
   * 空态插图。默认收件箱；页面可换成更贴切的语义图标（直播用 Tv、
   * 收藏用 Star…）。装饰性图形，语义仍由标题承担，`aria-hidden`。
   */
  icon?: LucideIcon;
}

/** 空态占位：所有列表在无数据时都应落到这里。 */
export default function Empty({
  title,
  description,
  action,
  icon: Icon = Inbox,
}: EmptyProps) {
  return (
    <div className="empty">
      <div className="empty__icon" aria-hidden="true">
        <Icon {...ICON_PROPS} />
      </div>
      <p className="empty__title">{title}</p>
      {description ? <p className="empty__desc">{description}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}
