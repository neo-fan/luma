import { createElement, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Icon from "./Icon";
import { useProxiedImage } from "../hooks/useProxiedImage";
import { plainText } from "../lib/format";
import { formatVotes } from "../lib/douban";
import type { DoubanMeta } from "../lib/douban";
import type { VodInfo } from "../types/luma";

export interface VodMetaHeroProps {
  /** 详情页与播放页共用一套「豆瓣优先、源站逐项兜底」的影片信息渲染。 */
  variant: "detail" | "player";
  vod: VodInfo | null;
  /** 豆瓣补全结果：命中时评分 / 年份 / 类型 / 导演 / 主演 / 简介都用豆瓣。 */
  douban?: DoubanMeta | null;
  /**
   * 豆瓣资料还在路上。
   *
   * 只用来说明「这一屏还会变」，所以提示放在元信息行尾（横向增删），
   * 不新增行、不占位——失败时它直接消失，版面不回收。
   */
  doubanPending?: boolean;
  /**
   * 片名兜底（路由片名 / 列表卡片片名）。
   *
   * 有些源把 `vod_name` 恒写成空串（detailContent 只回播放串），只认
   * `vod.vod_name` 时整页标题会退化成「未命名」。
   */
  fallbackName?: string;
  /** 片名行尾的附加内容（详情页的收藏星）。 */
  titleExtra?: ReactNode;
  /** 片名右侧的小操作区（播放页的换源 / 外部播放）。 */
  titleActions?: ReactNode;
  /** 片名下方的一行小字（播放页的站点名与当前线路）。 */
  meta?: ReactNode;
  /** 简介下方的动作区（详情页的播放按钮；展开按钮由本组件负责）。 */
  footer?: ReactNode;
  /** 简介为空时的占位文案；undefined 表示整段简介都不渲染。 */
  descriptionFallback?: string;
  /** 海报完全取不到时的占位文案。 */
  posterPlaceholder?: string;
}

const VARIANTS = {
  detail: {
    root: "detail-hero",
    poster: "detail-poster",
    info: "detail-info",
    titleRow: "detail-title-row",
    title: "detail-title",
    titleActions: "detail-actions detail-actions--inline",
    meta: "page-meta",
    footer: "detail-actions detail-actions--inline",
    placeholder: "vod-card__ph",
    heading: "h1",
  },
  player: {
    root: "player-about",
    poster: "player-about__poster",
    info: "player-about__body",
    titleRow: "player-about__top",
    title: "player-about__title",
    titleActions: "player-about__actions",
    meta: "player-about__meta",
    footer: null,
    placeholder: "player-about__ph",
    heading: "h2",
  },
} as const;

/**
 * 影片信息头：海报 + 片名 + 评分/年份/类型 + 导演主演 + 简介。
 *
 * 详情页与播放页共用这一份实现，避免两处各写一套取值逻辑、改一处漂移另一处。
 * 豆瓣命中时元数据以豆瓣为准；`vod_remarks`
 * （更新到第几集）属于播放状态，只有源站知道，继续保留。豆瓣缺席时逐项
 * 回退源站字段；海报反过来——源站优先，源站缺失或取图失败才用豆瓣兜底。
 */
export default function VodMetaHero({
  variant,
  vod,
  douban,
  doubanPending,
  fallbackName,
  titleExtra,
  titleActions,
  meta,
  footer,
  descriptionFallback,
  posterPlaceholder,
}: VodMetaHeroProps) {
  const style = VARIANTS[variant];
  const sourcePoster = useProxiedImage(vod?.vod_pic);
  const doubanPoster = useProxiedImage(douban?.pic);
  // 豆瓣命中优先用豆瓣海报（版式统一、2:3 标准裁切）；豆瓣没命中 / 图裂 / 还没加载完时用源站封面兜底。
  const poster =
    doubanPoster.src && !doubanPoster.broken ? doubanPoster : sourcePoster;
  const hasPoster = Boolean(poster.src) && !poster.broken;
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const contentRef = useRef<HTMLParagraphElement | null>(null);

  // 片名优先级：源站 → 路由/卡片兜底 → 豆瓣。豆瓣放最后是因为它只在本片
  // 命中时才有值，而源站与路由是「这部片一定叫什么」的直接证据。
  const title =
    vod?.vod_name?.trim() ||
    fallbackName?.trim() ||
    douban?.title?.trim() ||
    "未命名";
  const votes = douban && douban.ratingCount > 0 ? formatVotes(douban.ratingCount) : "";
  // 发现型源（豆瓣[py] 等）把评分写进 `vod_remarks`（「电影评分 8.6」）。豆瓣
  // 命中时评分已由 chips 第一项给出，这句只是重复信息，去掉。
  const remark = vod?.vod_remarks?.trim() ?? "";
  const playState = /^(电影|剧集|综艺)?评分/.test(remark) ? "" : remark;
  const chips = douban
    ? [
        douban.rating > 0
          ? `★ ${douban.rating.toFixed(1)}${votes ? ` · ${votes}` : ""}`
          : "",
        douban.year,
        douban.genres.join(" · "),
        playState,
      ].filter((item): item is string => Boolean(item))
    : [vod?.vod_year, vod?.vod_area, vod?.type_name, vod?.vod_remarks]
        .map((item) => item?.trim())
        .filter((item): item is string => Boolean(item));
  const director = douban?.directors.length
    ? douban.directors.join(" / ")
    : plainText(vod?.vod_director);
  const actors = douban?.actors.length
    ? douban.actors.join(" / ")
    : plainText(vod?.vod_actor);
  /** 只在「还没有豆瓣资料、但请求已经在路上」时提示，资料到货即消失。 */
  const filling = Boolean(doubanPending) && !douban;
  /**
   * 简介取值：豆瓣 → 源站 → 占位。
   *
   * 正在补全且两边都没有正文时不能报「暂无简介」——那是在断言「这部片没有简介」，
   * 而事实只是还没拿到。换一句进行中的话，避免用户把等待读成缺失。
   */
  const description =
    plainText(douban?.intro) ||
    plainText(vod?.vod_content) ||
    (filling && descriptionFallback ? "正在获取简介…" : descriptionFallback) ||
    "";
  /**
   * 资料源标记：`data-douban` 从 source 翻成 full 时，CSS 让这几块淡入一次。
   * 不换 key、不重挂载——重挂载会把「展开全文」的展开态和溢出测量一起清掉，
   * 用户正在读的简介会当场收起。
   */
  const source = douban ? "full" : "source";

  useLayoutEffect(() => {
    // 展开态不重新测量，否则「已展开」时 scrollHeight === clientHeight，
    // 按钮会当场消失、再也收不回去；保留上一次测得的 true 即可。
    if (expanded) {
      return;
    }
    const el = contentRef.current;
    if (!el) {
      setOverflowing(false);
      return;
    }
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [description, expanded]);

  const moreButton =
    overflowing || expanded ? (
      <button
        type="button"
        className="detail-content__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "收起简介" : "展开全文"}
        <Icon name="chevron" size={14} />
      </button>
    ) : null;

  return (
    <div className={style.root} data-douban={source}>
      <div className={style.poster}>
        {hasPoster ? (
          <img
            src={poster.src ?? ""}
            alt={title}
            referrerPolicy="no-referrer"
            onError={poster.onError}
          />
        ) : posterPlaceholder ? (
          <span className={style.placeholder}>{posterPlaceholder}</span>
        ) : null}
      </div>

      <div className={style.info}>
        <div className={style.titleRow}>
          {createElement(
            style.heading,
            {
              className: style.title,
              title: variant === "player" ? title : undefined,
            },
            title,
          )}
          {titleExtra}
          {titleActions ? <div className={style.titleActions}>{titleActions}</div> : null}
        </div>

        {meta ? <p className={style.meta}>{meta}</p> : null}

        {chips.length > 0 || filling ? (
          <div className="chip-row chip-row--static">
            {chips.map((chip, index) => (
              <span className="chip chip--static" key={`${chip}-${index}`}>
                {chip}
              </span>
            ))}
            {filling ? (
              <span className="chip chip--static chip--pending" role="status">
                豆瓣资料补全中…
              </span>
            ) : null}
          </div>
        ) : null}

        {director ? <p className="detail-line">导演：{director}</p> : null}
        {actors ? <p className="detail-line">主演：{actors}</p> : null}

        {description ? (
          <>
            <p
              ref={contentRef}
              className={
                expanded ? "detail-content is-expanded" : "detail-content is-clamped"
              }
            >
              {description}
            </p>
            {moreButton}
          </>
        ) : null}

        {style.footer ? <div className={style.footer}>{footer}</div> : null}
      </div>
    </div>
  );
}
