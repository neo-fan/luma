import { memo, useCallback, useRef } from "react";
import { useProxiedImage } from "../hooks/useProxiedImage";

interface VodCardProps {
  title: string;
  pic?: string;
  remarks?: string;
  /** 次要说明，收藏页用来显示站点名 */
  sub?: string;
  onOpen: () => void;
}

/**
 * 聚合搜索一次能出 200+ 张卡片，调用方传的 onOpen 是内联箭头函数（每次渲染
 * 都是新引用）。这里只比较展示字段，点击时通过 ref 转发最新回调，让 memo
 * 在父组件无关状态变化（进度、筛选开关、加载文案）时真正跳过重渲染。
 */
function sameCard(a: VodCardProps, b: VodCardProps): boolean {
  return a.title === b.title && a.pic === b.pic && a.remarks === b.remarks && a.sub === b.sub;
}

/** 统一的影片卡片：封面 + 角标 + 标题。 */
const VodCard = memo(function VodCard({ title, pic, remarks, sub, onOpen }: VodCardProps) {
  // TVBox `vod_pic` may carry inline @header suffix; route through the local
  // /image proxy so the Rust host can inject them (WebView2 <img> cannot).
  const { src: cover, broken, onError: handleError } = useProxiedImage(pic);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const handleOpen = useCallback(() => onOpenRef.current(), []);

  return (
    <button type="button" className="vod-card" onClick={handleOpen} title={title}>
      <div className="vod-card__poster">
        {cover && !broken ? (
          <img
            src={cover}
            alt={title}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={handleError}
          />
        ) : (
          <span className="vod-card__ph">{broken || pic?.trim() ? "无封面" : ""}</span>
        )}
        {remarks ? <span className="vod-card__badge">{remarks}</span> : null}
      </div>
      <div className="vod-card__title">{title || "未命名"}</div>
      {sub ? <div className="vod-card__sub">{sub}</div> : null}
    </button>
  );
}, sameCard);

export default VodCard;
