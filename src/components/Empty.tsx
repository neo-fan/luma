import type { ReactNode } from "react";

interface EmptyProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

/** 空态占位：所有列表在无数据时都应落到这里。 */
export default function Empty({ title, description, action }: EmptyProps) {
  return (
    <div className="empty">
      <div className="empty__icon" aria-hidden="true">
        ▤
      </div>
      <p className="empty__title">{title}</p>
      {description ? <p className="empty__desc">{description}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}
