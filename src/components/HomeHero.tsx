import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Play } from "lucide-react";
import useDoubanMeta from "../hooks/useDoubanMeta";
import { useProxiedImage } from "../hooks/useProxiedImage";
import { formatVotes } from "../lib/douban";
import { plainText } from "../lib/format";
import type { VodInfo } from "../types/tvbox";

export interface HomeHeroProps {
  /** 轮播候选项（通常取推荐列表前几条）；第一张作为首帧。 */
  items: readonly VodInfo[];
  onOpen: (vod: VodInfo) => void;
  /** 推荐条目缺元数据时的兜底文案（站点名）；头图不再单独显示来源小字。 */
  site?: string;
}

const ROTATE_MS = 6500;

/**
 * 首页沉浸头图：整幅背景 + 海报 + 大字标题，像腾讯视频首页那样先给一个
 * 「这一屏是内容」的画面，而不是顶着一排工具栏和网格。自动轮播推荐列表前
 * 几条，悬停 / 键盘聚焦 / 用户偏好减少动效时停止轮播。
 */
export default function HomeHero({ items, onOpen, site }: HomeHeroProps) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = items.length;
  const current = count > 0 ? items[Math.min(index, count - 1)] : undefined;
  const source = useProxiedImage(current?.vod_pic);
  const douban = useDoubanMeta(current?.vod_name, current?.vod_year, Boolean(current));
  const doubanImage = useProxiedImage(douban?.pic);
  // 源站封面优先；源站没给（或取图失败）时用豆瓣海报兜底。
  const useDoubanPoster =
    Boolean(douban?.pic?.trim()) && (!current?.vod_pic?.trim() || source.broken);
  const {
    src: cover,
    broken,
    loading,
    onError: handleError,
    onLoad: handleLoad,
  } = useDoubanPoster ? doubanImage : source;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    if (paused || count <= 1) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(
      () => setIndex((value) => (value + 1) % count),
      ROTATE_MS,
    );
    return () => window.clearInterval(timer);
  }, [paused, count]);

  /**
   * 豆瓣命中就以豆瓣为准：评分 / 评价人数 / 年份 / 类型；没命中沿用源站的
   * 集数、年份、地区，再退到站点名。
   */
  const meta = useMemo(() => {
    if (!current) return "";
    if (douban) {
      const votes = douban.ratingCount > 0 ? formatVotes(douban.ratingCount) : "";
      return [
        douban.rating > 0 ? `★ ${douban.rating.toFixed(1)}` : "",
        votes,
        douban.year || current.vod_year,
        douban.genres.join(" · "),
      ]
        .filter(Boolean)
        .join(" · ");
    }
    return (
      [current.vod_remarks, current.vod_year, current.vod_area].filter(Boolean).join(" · ") ||
      site ||
      ""
    );
  }, [current, douban, site]);

  const handleOpen = useCallback(() => {
    if (current) onOpenRef.current(current);
  }, [current]);

  // 头图给两行剧情简介：没有简介时整段不渲染，不留空行。
  const intro = plainText(douban?.intro) || plainText(current?.vod_content);

  const step = useCallback(
    (direction: 1 | -1) => {
      setIndex((value) => (value + direction + count) % Math.max(count, 1));
    },
    [count],
  );

  if (!current) return null;
  const title = current.vod_name || "未命名";

  return (
    <section
      className="home-hero"
      aria-roledescription="轮播"
      aria-label="推荐内容"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className="home-hero__backdrop" aria-hidden="true">
        {cover && !broken ? (
          <img src={cover} alt="" onError={handleError} onLoad={handleLoad} />
        ) : null}
      </div>
      <div className="home-hero__scrim" aria-hidden="true" />

      <div className="home-hero__body">
        <span className="home-hero__poster">
          {cover && !broken ? (
            <img src={cover} alt="" referrerPolicy="no-referrer" />
          ) : (
            <span className="home-hero__poster-ph" aria-hidden="true" />
          )}
          {loading ? <span className="home-hero__poster-skeleton" aria-hidden="true" /> : null}
        </span>

        <div className="home-hero__text" key={current.vod_id}>
          <h2 className="home-hero__title">{title}</h2>
          {meta ? <p className="home-hero__meta">{meta}</p> : null}
          {intro ? <p className="home-hero__intro">{intro}</p> : null}
          <div className="home-hero__actions">
            <button type="button" className="btn btn--primary" onClick={handleOpen}>
              <Play size={16} aria-hidden="true" />
              立即观看
            </button>
          </div>
        </div>
      </div>

      {count > 1 ? (
        <div className="home-hero__controls">
          <button
            type="button"
            className="home-hero__arrow"
            onClick={() => step(-1)}
            aria-label="上一张推荐"
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <div className="home-hero__dots">
            {items.map((vod, dot) => (
              <button
                key={String(vod.vod_id)}
                type="button"
                className={dot === index ? "home-hero__dot is-active" : "home-hero__dot"}
                onClick={() => setIndex(dot)}
                aria-label={`第 ${dot + 1} 张推荐`}
                aria-current={dot === index}
              />
            ))}
          </div>
          <button
            type="button"
            className="home-hero__arrow"
            onClick={() => step(1)}
            aria-label="下一张推荐"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </section>
  );
}
