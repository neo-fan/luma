import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import PosterTile from "./PosterTile";
import type { VodInfo } from "../types/tvbox";

export interface PosterRailProps {
  title: string;
  items: readonly VodInfo[];
  onOpen: (vod: VodInfo) => void;
  site?: string;
}

/**
 * 首页的横向推荐条（腾讯视频式）：一行海报、可左右翻、标题在左上。
 *
 * 不做滚轮劫持——鼠标滚轮在横排上继续滚页面；横向翻页用两侧箭头、触控板
 * 横扫或 Shift + 滚轮。箭头只在真的溢出时出现。
 */
export default function PosterRail({ title, items, onOpen, site }: PosterRailProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);

  const sync = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    setOverflow(track.scrollWidth > track.clientWidth + 4);
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

  const scrollPage = useCallback((direction: 1 | -1) => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollBy({ left: direction * track.clientWidth * 0.82, behavior: "smooth" });
  }, []);

  if (items.length === 0) return null;

  return (
    <section className="poster-rail" aria-label={title}>
      <header className="poster-rail__head">
        <h2 className="poster-rail__title">{title}</h2>
        {overflow ? (
          <div className="poster-rail__arrows">
            <button
              type="button"
              className="poster-rail__arrow"
              onClick={() => scrollPage(-1)}
              aria-label={`${title}：向左翻`}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="poster-rail__arrow"
              onClick={() => scrollPage(1)}
              aria-label={`${title}：向右翻`}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </header>
      <div className="poster-rail__track" ref={trackRef}>
        {items.map((vod) => (
          <PosterTile key={String(vod.vod_id)} vod={vod} onOpen={onOpen} site={site} />
        ))}
      </div>
    </section>
  );
}
