import { useState } from "react";

interface VodCardProps {
  title: string;
  pic?: string;
  remarks?: string;
  /** 次要说明，收藏页用来显示站点名 */
  sub?: string;
  onOpen: () => void;
}

/** 统一的影片卡片：封面 + 角标 + 标题。 */
export default function VodCard({ title, pic, remarks, sub, onOpen }: VodCardProps) {
  const [broken, setBroken] = useState(false);
  const cover = pic?.trim();

  return (
    <button type="button" className="vod-card" onClick={onOpen} title={title}>
      <div className="vod-card__poster">
        {cover && !broken ? (
          <img
            src={cover}
            alt={title}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setBroken(true)}
          />
        ) : (
          <span className="vod-card__ph">无封面</span>
        )}
        {remarks ? <span className="vod-card__badge">{remarks}</span> : null}
      </div>
      <div className="vod-card__title">{title || "未命名"}</div>
      {sub ? <div className="vod-card__sub">{sub}</div> : null}
    </button>
  );
}
