import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useProxiedImage } from "../hooks/useProxiedImage";
import { fetchDoubanMeta } from "../lib/douban";

interface VodCardProps {
  title: string;
  pic?: string;
  remarks?: string;
  /**
   * 播放过的分辨率（`1080P` / `2K` / `4K`）。
   *
   * 站点数据里没有这个字段，只有真播出画面才拿得到——历史 / 收藏页把它当作
   * 「确实播成功过」的证据展示，没播过的条目传空即可。
   */
  resolution?: string;
  /** 次要说明，收藏页用来显示站点名 */
  sub?: string;
  /**
   * 压在封面底部的信息行（历史页用：集数 / 进度 / 线路 / 时间）。
   * 标题行因此只留片名，长片名也不会再被副标题挤成两截。
   */
  coverMeta?: string[];
  /** 悬停提示，缺省用片名；历史页塞完整的「线路 · 集数 · 站点 · 进度 · 时间」。 */
  hint?: string;
  /**
   * 源站没给封面（或取图失败）时，按片名去豆瓣要一张。
   *
   * 只有历史 / 收藏页传这两个字段：那两张表的封面常常是空的，而豆瓣一定有。
   * 首页 / 搜索 / 分类的卡片不传——列表数据本身就带封面，不该为了封面去打
   * 豆瓣（用户明确要求搜索列表只用源站数据，避免频繁请求豆瓣）。
   */
  doubanTitle?: string;
  doubanYear?: string;
  onOpen: () => void;
}

/**
 * 聚合搜索一次能出 200+ 张卡片，调用方传的 onOpen 是内联箭头函数（每次渲染
 * 都是新引用）。这里只比较展示字段，点击时通过 ref 转发最新回调，让 memo
 * 在父组件无关状态变化（进度、筛选开关、加载文案）时真正跳过重渲染。
 */
function sameCard(a: VodCardProps, b: VodCardProps): boolean {
  return (
    a.title === b.title &&
    a.pic === b.pic &&
    a.remarks === b.remarks &&
    a.resolution === b.resolution &&
    a.sub === b.sub &&
    a.hint === b.hint &&
    a.doubanTitle === b.doubanTitle &&
    a.doubanYear === b.doubanYear &&
    // coverMeta 每次渲染都是新数组，用内容比较而不是引用比较。
    (a.coverMeta?.join("\u0001") ?? "") === (b.coverMeta?.join("\u0001") ?? "")
  );
}

/** 统一的影片卡片：封面 + 角标 + 标题（可选封面信息条与副标题）。 */
const VodCard = memo(function VodCard({
  title,
  pic,
  remarks,
  resolution,
  sub,
  coverMeta,
  hint,
  doubanTitle,
  doubanYear,
  onOpen,
}: VodCardProps) {
  const rootRef = useRef<HTMLButtonElement | null>(null);
  const [doubanPic, setDoubanPic] = useState("");
  /** 卡片进入过视口才发豆瓣请求：懒加载，翻不到的地方一个请求都不发。 */
  const [inView, setInView] = useState(false);

  // TVBox `vod_pic` may carry inline @header suffix; route through the local
  // /image proxy so the Rust host can inject them (WebView2 <img> cannot).
  const sourcePic = pic?.trim() ?? "";
  const source = useProxiedImage(sourcePic || undefined);
  const sourceBroken = source.broken;
  const needsDouban = Boolean(doubanTitle) && (!sourcePic || sourceBroken);

  useEffect(() => {
    if (!needsDouban || inView) {
      return;
    }
    const node = rootRef.current;
    if (!node) {
      return;
    }
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
      // 提前一屏开始要：滚到时封面基本已经在路上。
      { rootMargin: "320px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [needsDouban, inView]);

  useEffect(() => {
    if (!inView || doubanPic || !needsDouban || !doubanTitle) {
      return;
    }
    let alive = true;
    void fetchDoubanMeta(doubanTitle, doubanYear || undefined).then((meta) => {
      const next = meta?.pic?.trim() || "";
      if (alive && next) {
        setDoubanPic(next);
      }
    });
    return () => {
      alive = false;
    };
  }, [inView, doubanPic, needsDouban, doubanTitle, doubanYear]);

  // 源站封面能用就用源站的；没有或取图失败时才落到豆瓣海报。
  const useDouban = Boolean(doubanPic) && (!sourcePic || sourceBroken);
  const poster = useProxiedImage(
    useDouban ? doubanPic : sourcePic || undefined,
  );
  const { src: cover, broken, loading, onError: handleError, onLoad: handleLoad } =
    poster;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const handleOpen = useCallback(() => onOpenRef.current(), []);
  const meta = (coverMeta ?? []).filter(Boolean);
  /** 首字：失败占位用它做一个可辨识的锚点，比统一灰字有用。 */
  const initial = (title || "?").trim().charAt(0) || "?";

  return (
    <button
      type="button"
      className={meta.length > 0 ? "vod-card vod-card--meta" : "vod-card"}
      onClick={handleOpen}
      ref={rootRef}
      title={hint ?? title}
    >
      <div className="vod-card__poster">
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
            {/* 加载中：骨架提示。上游图床经常要几秒（实测 p50 129ms、max 5.2s），
                没有这层提示，用户看到的就是一片纯色块，分不清「在加载」还是「没图」。 */}
            {loading ? <span className="vod-card__skeleton" aria-hidden="true" /> : null}
          </>
        ) : broken ? (
          // 加载失败：用片名首字做锚点，明确告诉用户「这张有片名但没图」，
          // 而不是笼统的「无封面」。
          <span className="vod-card__ph vod-card__ph--failed" aria-hidden="true">
            {initial}
          </span>
        ) : (
          <span className="vod-card__ph">{pic?.trim() ? "无封面" : ""}</span>
        )}
        {remarks ? <span className="vod-card__badge">{remarks}</span> : null}
        {resolution ? <span className="vod-card__res">{resolution}</span> : null}
        {meta.length > 0 ? (
          <span className="vod-card__meta">
            {meta.map((line, index) => (
              <span
                className={
                  index === 0 ? "vod-card__meta-line" : "vod-card__meta-line vod-card__meta-line--dim"
                }
                key={`${index}-${line}`}
              >
                {line}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      <div className="vod-card__title">{title || "未命名"}</div>
      {sub ? <div className="vod-card__sub">{sub}</div> : null}
    </button>
  );
}, sameCard);

export default VodCard;
