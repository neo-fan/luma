import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import PosterTile from "./PosterTile";
import type { VodInfo } from "../types/luma";

export interface PosterRailProps {
  title: string;
  items: readonly VodInfo[];
  onOpen: (vod: VodInfo) => void;
  site?: string;
}

interface Edges {
  overflow: boolean;
  atStart: boolean;
  atEnd: boolean;
}

const INITIAL_EDGES: Edges = { overflow: false, atStart: true, atEnd: true };

/**
 * 首页的横向推荐条（腾讯视频式）：一行海报、可左右翻、标题在左上。
 *
 * 不做滚轮劫持——鼠标滚轮在横排上继续滚页面；横向翻页用两侧箭头、触控板
 * 横扫、Shift + 滚轮，或在横排上按左右方向键。箭头只在真的溢出时出现，到
 * 头了就置灰；左右边缘用渐隐提示「还有内容」，到头就收起。
 */
export default function PosterRail({ title, items, onOpen, site }: PosterRailProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const fadeStartRef = useRef<HTMLSpanElement>(null);
  const fadeEndRef = useRef<HTMLSpanElement>(null);
  const [edges, setEdges] = useState<Edges>(INITIAL_EDGES);

  const sync = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const overflow = track.scrollWidth > track.clientWidth + 4;
    setEdges({
      overflow,
      atStart: !overflow || track.scrollLeft <= 2,
      atEnd: !overflow || track.scrollLeft + track.clientWidth >= track.scrollWidth - 2,
    });
  }, []);

  useEffect(() => {
    sync();
    const track = trackRef.current;
    if (!track) return;
    const observer = new ResizeObserver(() => sync());
    observer.observe(track);
    track.addEventListener("scroll", sync, { passive: true });
    return () => {
      observer.disconnect();
      track.removeEventListener("scroll", sync);
    };
  }, [sync, items.length]);

  // 两侧渐隐常渲染，is-visible 控 opacity：滚到头是淡出收起，不再瞬隐。
  // className 字面量是窗口探针契约（homeImmersive），状态类走 classList 切换。
  useEffect(() => {
    fadeStartRef.current?.classList.toggle("is-visible", edges.overflow && !edges.atStart);
    fadeEndRef.current?.classList.toggle("is-visible", edges.overflow && !edges.atEnd);
  }, [edges]);

  const scrollPage = useCallback((direction: 1 | -1) => {
    const track = trackRef.current;
    if (!track) return;
    // 减弱动效时降级为瞬时翻页：平滑滚动不在全局动画降级覆盖范围内。
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    track.scrollBy({ left: direction * track.clientWidth * 0.82, behavior: reduced ? "auto" : "smooth" });
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        scrollPage(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        scrollPage(1);
      }
    },
    [scrollPage],
  );

  if (items.length === 0) return null;

  const { overflow, atStart, atEnd } = edges;

  return (
    <section
      className={`poster-rail${overflow ? " is-overflow" : ""}`}
      aria-label={title}
    >
      <header className="poster-rail__head">
        <h2 className="poster-rail__title">{title}</h2>
        {overflow ? (
          <div className="poster-rail__arrows">
            <button
              type="button"
              className="poster-rail__arrow"
              onClick={() => scrollPage(-1)}
              disabled={atStart}
              aria-label={`${title}：向左翻`}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="poster-rail__arrow"
              onClick={() => scrollPage(1)}
              disabled={atEnd}
              aria-label={`${title}：向右翻`}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </header>
      <div className="poster-rail__window">
        <div
          className="poster-rail__track"
          ref={trackRef}
          tabIndex={0}
          role="group"
          aria-label={`${title}：横向列表，可用左右方向键翻页`}
          onKeyDown={handleKeyDown}
        >
          {items.map((vod) => (
            <PosterTile key={String(vod.vod_id)} vod={vod} onOpen={onOpen} site={site} />
          ))}
        </div>
        <span
          className="poster-rail__fade poster-rail__fade--start"
          aria-hidden="true"
          ref={fadeStartRef}
        />
        <span
          className="poster-rail__fade poster-rail__fade--end"
          aria-hidden="true"
          ref={fadeEndRef}
        />
      </div>
    </section>
  );
}
