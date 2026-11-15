import { memo, useCallback, useEffect, useRef, useState } from "react";
import useDoubanMeta from "../hooks/useDoubanMeta";
import { useProxiedImage } from "../hooks/useProxiedImage";
import type { VodInfo } from "../types/tvbox";

export interface PosterTileProps {
  vod: VodInfo;
  onOpen: (vod: VodInfo) => void;
  /** 当前站点名：推荐条目不带宽高信息（没有集数/年份/地区）时，悬停至少能显示来源。 */
  site?: string;
}

/**
 * 首页推荐里的单张海报（墙 / 横排共用）。
 *
 * 跟 `.vod-card` 的区别：没有卡片外壳、没有角标和第二行标题，只留封面；片名
 * 压在海报底部的渐隐条上，其余信息（集数 / 年份 / 地区）悬停或键盘聚焦时才
 * 露出。分类 tab 继续用原来的卡片，不参与这里。
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
    src: sourceCover,
    broken: sourceBroken,
    loading: sourceLoading,
    onError: handleSourceError,
    onLoad: handleSourceLoad,
  } = useProxiedImage(vod.vod_pic);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const handleOpen = useCallback(() => onOpenRef.current(vod), [vod]);
  const rootRef = useRef<HTMLButtonElement | null>(null);
  /** 卡片进过视口才发豆瓣请求：一屏十几张，滚不到的地方一个请求都不发。 */
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (inView) return;
    const node = rootRef.current;
    if (!node) return;
    // 没有 IntersectionObserver 的环境（旧 WebView / 测试）直接当作已进视口。
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      // 提前一屏开始要：滚到时评分基本已经在路上。
      { rootMargin: "320px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [inView]);

  const douban = useDoubanMeta(vod.vod_name, vod.vod_year, inView);
  const title = vod.vod_name || "未命名";
  // 豆瓣命中优先用它的年份 / 类型；否则保持源站的集数 / 年份 / 地区，最后用站点名兜底。
  const meta = douban
    ? [douban.year, douban.genres.join(" · ")].filter(Boolean).join(" · ")
    : [vod.vod_remarks, vod.vod_year, vod.vod_area].filter(Boolean).join(" · ") || site || "";
  const {
    src: doubanCover,
    broken: doubanBroken,
    loading: doubanLoading,
    onError: handleDoubanError,
    onLoad: handleDoubanLoad,
  } = useProxiedImage(douban?.pic);
  /** 豆瓣命中就用豆瓣海报：这张卡本来就在拉豆瓣资料，不额外发请求；没命中 / 图裂时用源站封面兜底。 */
  const useDoubanCover = Boolean(doubanCover) && !doubanBroken;
  const cover = useDoubanCover ? doubanCover : sourceCover;
  const broken = useDoubanCover ? false : sourceBroken;
  const loading = useDoubanCover ? doubanLoading : sourceLoading;
  const handleError = useDoubanCover ? handleDoubanError : handleSourceError;
  const handleLoad = useDoubanCover ? handleDoubanLoad : handleSourceLoad;
  /** 失败时的锚点：用片名首字，比统一灰块更容易认出是哪张。 */
  const initial = title.trim().charAt(0) || "?";

  return (
    <button
      type="button"
      className="poster-tile"
      onClick={handleOpen}
      title={title}
      ref={rootRef}
    >
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
        {douban && douban.rating > 0 ? (
          <span className="poster-tile__rating" aria-hidden="true">
            ★ {douban.rating.toFixed(1)}
          </span>
        ) : null}
        <span className="poster-tile__scrim" aria-hidden="true" />
        <span className="poster-tile__info">
          <span className="poster-tile__title">{title}</span>
          {meta ? <span className="poster-tile__meta">{meta}</span> : null}
        </span>
      </span>
    </button>
  );
}, sameTile);

export default PosterTile;
