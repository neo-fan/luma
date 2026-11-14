import { useLayoutEffect, useRef, useState } from "react";
import { useProxiedImage } from "../../hooks/useProxiedImage";
import IconButton from "../IconButton";
import { plainText } from "../../lib/format";
import type { VodInfo } from "../../types/tvbox";

interface PlayerAboutProps {
  vod: VodInfo | null;
  /** 详情还没回来时的片名兜底（路由参数）。 */
  fallbackName: string;
  siteKey: string;
  siteName?: string;
  /** 当前线路名，展示成「正在播放：线路 · 第 N 集」。 */
  lineName?: string;
  episodeLabel?: string;
  /** 直播频道没有「换源」概念，传 undefined 即不渲染该按钮。 */
  onSwitchSource?: () => void;
  /** 外部播放开关关闭时由调用方传 undefined，按钮整体不渲染。 */
  onPlayExternal?: () => void;
}

/**
 * 简介折叠：按**实际是否溢出**决定要不要给展开按钮，不按字数猜。
 *
 * 以前用 `description.length > 160` 判断：中文 160 字在宽屏上可能只有两行、
 * 根本没超过 clamp 的 84px，按钮却照样出现——点了 `aria-expanded` 变了、
 * 画面纹丝不动，用户自然认为「展开逻辑失效」。行数与容器宽度、字号、中英混排
 * 都有关，只能量 DOM：`scrollHeight > clientHeight` 才是真溢出。
 */
/**
 * 播放器下方的影片信息卡：海报 + 片名 + 年份/地区/类型 + 导演主演 + 简介，
 * 换源 / 外部播放（开关打开时）放在卡片操作区。详情拿不到时只显示片名与站点，不留白板。
 */
export default function PlayerAbout({
  vod,
  fallbackName,
  siteKey,
  siteName,
  lineName,
  episodeLabel,
  onSwitchSource,
  onPlayExternal,
}: PlayerAboutProps) {
  const poster = useProxiedImage(vod?.vod_pic);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const contentRef = useRef<HTMLParagraphElement | null>(null);

  const title = vod?.vod_name?.trim() || fallbackName || "未命名";
  const chips = [vod?.vod_year, vod?.vod_area, vod?.type_name, vod?.vod_remarks]
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item));
  const description = plainText(vod?.vod_content);
  const hasPoster = Boolean(poster.src) && !poster.broken;

  useLayoutEffect(() => {
    // 展开态不重新测量，否则「已展开」时 scrollHeight === clientHeight，
    // 按钮会当场消失、再也收不回去；保留上一次测得的 true 即可。
    if (expanded) {
      return;
    }
    const el = contentRef.current;
    if (!el) {
      return;
    }
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [description, expanded]);

  return (
    <section className="player-about">
      <div className="player-about__poster">
        {hasPoster ? (
          <img
            src={poster.src ?? ""}
            alt={title}
            referrerPolicy="no-referrer"
            onError={poster.onError}
          />
        ) : (
          <span className="player-about__ph">无封面</span>
        )}
      </div>

      <div className="player-about__body">
        <div className="player-about__top">
          <h2 className="player-about__title" title={title}>
            {title}
          </h2>
          <div className="player-about__actions">
            {onSwitchSource ? (
              <IconButton name="swap" label="换源" onClick={onSwitchSource} />
            ) : null}
            {onPlayExternal ? (
              <IconButton
                name="external"
                label="外部播放"
                onClick={onPlayExternal}
              />
            ) : null}
          </div>
        </div>

        <p className="player-about__meta">
          <span className="detail-source" title={siteKey}>
            {siteName || siteKey}
          </span>
          {lineName ? (
            <span className="player-about__now">
              {lineName}
              {episodeLabel ? ` · ${episodeLabel}` : ""}
            </span>
          ) : null}
        </p>

        {chips.length > 0 ? (
          <div className="chip-row chip-row--static">
            {chips.map((chip, index) => (
              <span className="chip chip--static" key={`${chip}-${index}`}>
                {chip}
              </span>
            ))}
          </div>
        ) : null}

        {vod?.vod_director ? (
          <p className="detail-line">导演：{plainText(vod.vod_director)}</p>
        ) : null}
        {vod?.vod_actor ? (
          <p className="detail-line">主演：{plainText(vod.vod_actor)}</p>
        ) : null}

        {description ? (
          <>
            <p
              ref={contentRef}
              className={
                expanded ? "detail-content" : "detail-content is-clamped"
              }
            >
              {description}
            </p>
            {overflowing || expanded ? (
              <IconButton
                name="chevron"
                label={expanded ? "收起简介" : "展开简介"}
                expanded={expanded}
                className="icon-btn--sm icon-btn--rotate player-about__more"
                onClick={() => setExpanded((value) => !value)}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
