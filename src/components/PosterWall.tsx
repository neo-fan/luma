import { memo, useCallback, useRef } from "react";
import { useProxiedImage } from "../hooks/useProxiedImage";
import type { VodInfo } from "../types/tvbox";

export interface PosterWallProps {
  items: readonly VodInfo[];
  onOpen: (vod: VodInfo) => void;
  /** 当前站点名：推荐条目不带宽高信息（没有集数/年份/地区）时，悬停至少能显示来源。 */
  site?: string;
}

interface PosterTileProps {
  vod: VodInfo;
  onOpen: (vod: VodInfo) => void;
  site?: string;
}

/**
 * 首页推荐区的纯海报墙。
 *
 * 跟 `.vod-grid` + `VodCard` 的区别：没有卡片外壳、没有角标和第二行标题，
 * 只留封面；片名压在海报底部的渐隐条上，其余信息（集数 / 年份 / 地区）
 * 悬停或键盘聚焦时才露出。分类 tab 继续用原来的卡片，不参与这里。
 */

/** 只比较会影响渲染的字段：父组件因为加载态 / 筛选变化重渲染时跳过重渲染。 */
function sameTile(a: PosterTileProps, b: PosterTileProps): boolean {
  const left = a.vod;
  const right = b.vod;
  return (
    left.vod_id === right.vod_id &&
    left.vod_name === right.vod_name &&
    left.vod_pic === right.vod_pic &&
    left.vod_remarks === right.vod_remarks &&
    left.vod_year === right.vod_year &&
    left.vod_area === right.vod_area &&
    a.site === b.site
  );
}

const PosterTile = memo(function PosterTile({ vod, onOpen, site }: PosterTileProps) {
  const {
    src: cover,
    broken,
    loading,
    onError: handleError,
    onLoad: handleLoad,
  } = useProxiedImage(vod.vod_pic);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const handleOpen = useCallback(() => onOpenRef.current(vod), [vod]);
  const title = vod.vod_name || "未命名";
  // 推荐列表常常只有片名和封面（集数年份地区都不带），这时用站点名兜底，
  // 保证「悬停有信息」而不是空一条。
  const meta =
    [vod.vod_remarks, vod.vod_year, vod.vod_area].filter(Boolean).join(" · ") || site || "";
  /** 失败时的锚点：用片名首字，比统一灰块更容易认出是哪张。 */
  const initial = title.trim().charAt(0) || "?";

  return (
    <button type="button" className="poster-tile" onClick={handleOpen} title={title}>
      <span className="poster-tile__frame">
        {cover && !broken ? (
          <>
            <img
              src={cover}
              alt={title}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={handleError}
              onLoad={handleLoad}
            />
            {/* 底色就是「图还没到」，不叠扫光：一屏十几张同时动 = 一直在闪。 */}
            {loading ? <span className="poster-tile__skeleton" aria-hidden="true" /> : null}
          </>
        ) : broken ? (
          <span className="poster-tile__ph poster-tile__ph--failed" aria-hidden="true">
            {initial}
          </span>
        ) : (
          <span className="poster-tile__ph" aria-hidden="true" />
        )}
        <span className="poster-tile__scrim" aria-hidden="true" />
        <span className="poster-tile__info">
          <span className="poster-tile__title">{title}</span>
          {meta ? <span className="poster-tile__meta">{meta}</span> : null}
        </span>
      </span>
    </button>
  );
}, sameTile);

const PosterWall = memo(function PosterWall({ items, onOpen, site }: PosterWallProps) {
  return (
    <div className="poster-wall">
      {items.map((vod) => (
        <PosterTile key={String(vod.vod_id)} vod={vod} onOpen={onOpen} site={site} />
      ))}
    </div>
  );
});

export default PosterWall;
