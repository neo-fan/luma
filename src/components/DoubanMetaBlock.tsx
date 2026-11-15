/**
 * 详情页的「豆瓣信息」区块：评分 / 评价人数 / 导演主演类型 / 简介 / 海报。
 *
 * 两条和页面其他区块不同的规则：
 * 1. **只在有数据时存在**。父组件拿到 `null` 就根本不渲染它，所以这里没有
 *    loading 骨架、没有空态、没有占位——豆瓣拿不到时页面和没这个功能一样。
 * 2. **不抢源站的海报**。`posterFallback` 只在详情页自己没有 `vod_pic` 时才为
 *    true；源站给了封面就用源站的，豆瓣的海报只是兜底（且自己加载失败会
 *    安静隐藏，不显示破图）。
 *
 * 简介按 3 行夹取 + 「展开」按钮；夹取高度用 `max-height` 而不是
 * `-webkit-line-clamp`，因为后者量不出真实溢出的 `scrollHeight`
 * （详情页正文的折叠也是同一套做法）。
 */
import { useLayoutEffect, useRef, useState } from "react";

import Icon from "./Icon";
import { useProxiedImage } from "../hooks/useProxiedImage";
import type { DoubanMeta } from "../lib/douban";

/** 10000 以上换成「x.x 万人评价」，一行放得下。 */
function formatVotes(count: number): string {
  if (!Number.isFinite(count) || count <= 0) {
    return "";
  }
  if (count >= 10000) {
    return `${(count / 10000).toFixed(1).replace(/\.0$/, "")} 万人评价`;
  }
  return `${Math.round(count)} 人评价`;
}

function ChipGroup({
  label,
  values,
}: {
  label: string;
  values: string[];
}) {
  if (values.length === 0) {
    return null;
  }
  return (
    <div className="douban-meta__row">
      <span className="douban-meta__label">{label}</span>
      <span className="douban-meta__chips">
        {values.map((value) => (
          <span key={`${label}-${value}`} className="chip chip--static douban-meta__chip">
            {value}
          </span>
        ))}
      </span>
    </div>
  );
}

export default function DoubanMetaBlock({
  meta,
  posterFallback = false,
}: {
  meta: DoubanMeta;
  /** 详情页自己没有封面时才让豆瓣海报顶上，别跟源站抢。 */
  posterFallback?: boolean;
}) {
  const poster = useProxiedImage(posterFallback ? meta.pic || undefined : undefined);
  const [expanded, setExpanded] = useState(false);
  const [clampable, setClampable] = useState(false);
  const introRef = useRef<HTMLParagraphElement | null>(null);

  // 展开态量不出溢出（夹取被解除，scrollHeight == clientHeight），所以只在
  // 收起态测量；一旦确认能夹就保持有按钮，避免来回抖。
  useLayoutEffect(() => {
    if (expanded) {
      return;
    }
    const el = introRef.current;
    setClampable(!!el && el.scrollHeight > el.clientHeight + 1);
  }, [meta.intro, expanded]);

  const votes = formatVotes(meta.ratingCount);
  const hasRating = meta.rating > 0;
  const showPoster = !!poster.src && !poster.broken;

  return (
    <div className="douban-meta">
      {showPoster ? (
        <div className="douban-meta__poster">
          <img
            className="douban-meta__poster-img"
            src={poster.src ?? undefined}
            alt={meta.title ? `${meta.title} 海报` : "海报"}
            loading="lazy"
            decoding="async"
            onError={poster.onError}
            onLoad={poster.onLoad}
          />
        </div>
      ) : null}

      <div className="douban-meta__body">
        <div className="douban-meta__head">
          <span className="douban-meta__tag">豆瓣</span>
          {hasRating ? (
            <span className="douban-meta__rating">
              <span className="douban-meta__star" aria-hidden="true">
                ★
              </span>
              <strong>{meta.rating.toFixed(1)}</strong>
              {votes ? <span className="douban-meta__votes">{votes}</span> : null}
            </span>
          ) : (
            <span className="douban-meta__rating is-empty">暂无评分</span>
          )}
          {meta.year ? <span className="douban-meta__year">{meta.year}</span> : null}
        </div>

        <ChipGroup label="导演" values={meta.directors} />
        <ChipGroup label="主演" values={meta.actors} />
        <ChipGroup label="类型" values={meta.genres} />

        {meta.intro ? (
          <div className="douban-meta__intro-wrap">
            <p
              ref={introRef}
              className={
                expanded
                  ? "douban-meta__intro is-expanded"
                  : "douban-meta__intro is-clamped"
              }
            >
              {meta.intro}
            </p>
            {clampable || expanded ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm douban-meta__toggle"
                aria-expanded={expanded}
                onClick={() => setExpanded((prev) => !prev)}
              >
                {expanded ? "收起简介" : "展开简介"}
                <Icon name="chevron" size={14} className="douban-meta__caret" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
