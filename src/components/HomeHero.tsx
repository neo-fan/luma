import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Play } from "lucide-react";
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
  // 背景层栈：换片时把「刚离开的那张」留在底下慢慢褪，新的一张淡入进来。
  // 不能用 `items[index - 1]` 反推上一层——反向滚动或点圆点跳转时，那并不是
  // 用户刚看到的图，会闪出一张无关海报。
  const [layers, setLayers] = useState<{ id: number; item: VodInfo }[]>([]);
  const layerSeq = useRef(0);

  // 淡出结束后把旧层从 DOM 里摘掉：动效结束时它本来就是 opacity 0，
  // 但「减少动效」下没有动画、或动画被打断时，留着就会变成一张不该存在
  // 的底图——每一帧只该有当前这一张。
  useEffect(() => {
    if (layers.length <= 1) return;
    const timer = window.setTimeout(() => {
      setLayers((prev) => (prev.length <= 1 ? prev : prev.slice(-1)));
    }, 760);
    return () => window.clearTimeout(timer);
  }, [layers]);

  useEffect(() => {
    if (!current) return;
    setLayers((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.item.vod_id === current.vod_id) return prev;
      // 只保留上一层用于淡出，更早的直接丢掉。
      return [
        ...prev.slice(-1),
        { id: ++layerSeq.current, item: current },
      ];
    });
  }, [current]);
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

  // 轮播永远向前走：只留「下一张」一个入口，圆点负责直接跳转。
  const next = useCallback(() => {
    setIndex((value) => (value + 1) % Math.max(count, 1));
  }, [count]);

  // 只接管横向滑动（触控板双指横滑 / Shift+滚轮），纵向滚动留给页面：
  // 鼠标往下滚是想看下面的内容，不该被头图吃掉。
  const heroRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = heroRef.current;
    if (!element || count <= 1) return;
    let lockUntil = 0;
    const onWheel = (event: WheelEvent) => {
      const horizontal = Math.abs(event.deltaX) >= Math.abs(event.deltaY);
      if (!horizontal && !event.shiftKey) return;
      const delta = event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)
        ? event.deltaY
        : event.deltaX;
      if (Math.abs(delta) < 4) return;
      event.preventDefault();
      const now = Date.now();
      if (now < lockUntil) return;
      lockUntil = now + 460;
      setIndex((value) => (value + (delta > 0 ? 1 : -1) + count) % count);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [count]);

  if (!current) return null;
  const title = current.vod_name || "未命名";

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
    >
      <div className="home-hero__backdrop" aria-hidden="true">
        {layers.map((layer) => (
          <HeroBackdrop
            key={layer.id}
            item={layer.item}
            leaving={layer.item.vod_id !== current.vod_id}
          />
        ))}
      </div>
      <div className="home-hero__scrim" aria-hidden="true" />

      <div className="home-hero__body">
        <span className="home-hero__poster" key={current.vod_id}>
          {cover && !broken ? (
            <img
              src={cover}
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
                  className={dot === index ? "home-hero__dot is-active" : "home-hero__dot"}
                  onClick={() => setIndex(dot)}
                  aria-label={`第 ${dot + 1} 张推荐`}
                  aria-current={dot === index}
                >
                  {dot === index ? (
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

/**
 * 头图背景的一层。每层自己取图，`leaving` 表达「这是刚离开的那张，正在褪」。
 * 单独拆成组件是为了按 item 各自调用 `useProxiedImage`（hook 不能写在 map 里）。
 */
function HeroBackdrop({ item, leaving }: { item: VodInfo; leaving: boolean }) {
  const image = useProxiedImage(item.vod_pic);
  const cover = image.src && !image.broken ? image.src : "";
  if (!cover) return null;
  return <img className={leaving ? "is-leaving" : "is-current"} src={cover} alt="" />;
}