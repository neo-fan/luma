import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Play } from "lucide-react";
import useDoubanMeta from "../hooks/useDoubanMeta";
import { useProxiedImage } from "../hooks/useProxiedImage";
import { formatVotes } from "../lib/douban";
import { plainText } from "../lib/format";
import type { VodInfo } from "../types/luma";

export interface HomeHeroProps {
  /** 轮播候选项（通常取推荐列表前几条）；第一张作为首帧。 */
  items: readonly VodInfo[];
  onOpen: (vod: VodInfo) => void;
  /** 推荐条目缺元数据时的兜底文案（站点名）；头图不再单独显示来源小字。 */
  site?: string;
}

/** 自动轮播间隔；同时是圆点进度条一圈的时长。 */
const ROTATE_MS = 6500;
/** 横向拖拽判定：超过这个位移、且横向明显大于纵向，才算翻页。 */
const SWIPE_MIN_PX = 48;
/** 滚轮翻页节流，避免一次触控板滑动连翻好几张。 */
const WHEEL_LOCK_MS = 460;

/**
 * 首页沉浸头图。
 *
 * 一屏只放**一个**视频：整幅模糊背景 + 一张海报 + 标题/评分/简介 + 一个动作按钮，
 * 像腾讯视频首页的焦点图。切换有三条路：
 *
 * 1. 自动轮播（每 {@link ROTATE_MS} 换一张，悬停 / 键盘聚焦 / 减少动效时暂停）；
 * 2. 手动：右侧贴边、平时隐形的「下一张」按钮，或底部圆点直接跳转；
 * 3. 手势：触控板双指横滑 / Shift+滚轮，或按住海报横向拖动。
 *
 * 刻意保持 DOM 稳定 —— 背景与海报都只有**一个** img 节点，换片只改 `src`，
 * 不按 key 重新挂载节点；否则在 dev 热更新/连续切换时容易留下上一帧的残留节点，
 * 看起来就像「一堆海报平铺在头图里」。
 */
export default function HomeHero({ items, onOpen, site }: HomeHeroProps) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = items.length;
  const safeIndex = count > 0 ? Math.min(index, count - 1) : 0;
  const current = count > 0 ? items[safeIndex] : undefined;

  const source = useProxiedImage(current?.vod_pic);
  const douban = useDoubanMeta(
    current?.vod_name,
    current?.vod_year,
    Boolean(current),
    // 头图是首页第一屏，评分/简介要与推荐卡的预取抢同一条队列时优先。
    true,
  );
  const doubanImage = useProxiedImage(douban?.pic);
  // 豆瓣命中就用豆瓣海报：版式统一、裁切标准（2:3）；豆瓣没给 / 图裂 / 还没到货时用源站封面兜底。
  const useDoubanPoster =
    Boolean(douban?.pic?.trim()) && Boolean(doubanImage.src) && !doubanImage.broken;
  const {
    src: cover,
    broken,
    loading,
    onError: handleError,
    onLoad: handleLoad,
  } = useDoubanPoster ? doubanImage : source;

  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const heroRef = useRef<HTMLElement | null>(null);

  /** 向前/向后翻，越界环绕。 */
  const go = useCallback(
    (step: number) => {
      if (count <= 1) return;
      setIndex((value) => (value + step + count) % count);
    },
    [count],
  );
  const next = useCallback(() => go(1), [go]);

  // 自动轮播：手动切换后重新计时（index 进依赖），悬停/聚焦/减少动效时不动。
  useEffect(() => {
    if (paused || count <= 1) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => {
      setIndex((value) => (value + 1) % count);
    }, ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [paused, count, index]);

  // 滚轮只接管横向（触控板双指横滑 / Shift+滚轮）；纵向滚动留给页面，
  // 用户往下滚是想看下面的内容。原生监听才能 preventDefault。
  useEffect(() => {
    const element = heroRef.current;
    if (!element || count <= 1) return;
    let lockUntil = 0;
    const onWheel = (event: WheelEvent) => {
      const horizontal = Math.abs(event.deltaX) >= Math.abs(event.deltaY);
      if (!horizontal && !event.shiftKey) return;
      const delta =
        event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)
          ? event.deltaY
          : event.deltaX;
      if (Math.abs(delta) < 4) return;
      event.preventDefault();
      const now = Date.now();
      if (now < lockUntil) return;
      lockUntil = now + WHEEL_LOCK_MS;
      setIndex((value) => (value + (delta > 0 ? 1 : -1) + count) % count);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [count]);

  // 按住横向拖动：不抢纵向滚动（CSS touch-action: pan-y），也不抢按钮点击。
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, a")) return;
    dragStart.current = { x: event.clientX, y: event.clientY };
  }, []);
  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const start = dragStart.current;
      dragStart.current = null;
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy) * 1.2) return;
      go(dx < 0 ? 1 : -1);
    },
    [go],
  );
  const handlePointerCancel = useCallback(() => {
    dragStart.current = null;
  }, []);

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

  if (!current) return null;
  const title = current.vod_name || "未命名";
  const hasCover = Boolean(cover) && !broken;

  return (
    <section
      ref={heroRef}
      className="home-hero"
      aria-roledescription="轮播"
      aria-label="推荐内容"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <div className="home-hero__backdrop" aria-hidden="true">
        {hasCover ? <img src={cover ?? undefined} alt="" referrerPolicy="no-referrer" /> : null}
      </div>
      <div className="home-hero__scrim" aria-hidden="true" />

      <div className="home-hero__body">
        <span className="home-hero__poster">
          {hasCover ? (
            <img
              src={cover ?? undefined}
              alt=""
              referrerPolicy="no-referrer"
              onError={handleError}
              onLoad={handleLoad}
            />
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
        <>
          <div className="home-hero__controls">
            <div className="home-hero__dots">
              {items.map((vod, dot) => (
                <button
                  key={String(vod.vod_id)}
                  type="button"
                  className={dot === safeIndex ? "home-hero__dot is-active" : "home-hero__dot"}
                  onClick={() => setIndex(dot)}
                  aria-label={`第 ${dot + 1} 张推荐`}
                  aria-current={dot === safeIndex}
                >
                  {dot === safeIndex ? (
                    <span
                      className="home-hero__dot-fill"
                      style={{ animationDuration: `${ROTATE_MS}ms` }}
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            className="home-hero__next"
            onClick={next}
            aria-label="下一张推荐"
          >
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </>
      ) : null}
    </section>
  );
}
