import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Play } from "lucide-react";
import { useProxiedImage } from "../hooks/useProxiedImage";
import type { VodInfo } from "../types/tvbox";

export interface HomeHeroProps {
  /** 轮播候选项（通常取推荐列表前几条）；第一张作为首帧。 */
  items: readonly VodInfo[];
  onOpen: (vod: VodInfo) => void;
  /** 推荐条目不带宽高信息时的兜底文案（站点名）。 */
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
  const {
    src: cover,
    broken,
    loading,
    onError: handleError,
    onLoad: handleLoad,
  } = useProxiedImage(current?.vod_pic);
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

  const meta = useMemo(() => {
    if (!current) return "";
    return (
      [current.vod_remarks, current.vod_year, current.vod_area].filter(Boolean).join(" · ") ||
      site ||
      ""
    );
  }, [current, site]);

  const handleOpen = useCallback(() => {
    if (current) onOpenRef.current(current);
  }, [current]);

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

        <div className="home-hero__text">
          <p className="home-hero__eyebrow">{site || "推荐"}</p>
          <h2 className="home-hero__title">{title}</h2>
          {meta ? <p className="home-hero__meta">{meta}</p> : null}
          <div className="home-hero__actions">
            <button type="button" className="btn btn--primary" onClick={handleOpen}>
              <Play size={16} aria-hidden="true" />
              立即观看
            </button>
            <button type="button" className="btn" onClick={handleOpen}>
              查看详情
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
