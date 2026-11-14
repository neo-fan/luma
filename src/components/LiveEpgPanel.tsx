import { useEffect, useRef, useState } from "react";
import ChannelLogo from "./ChannelLogo";
import { api, errorMessage } from "../lib/invoke";
import { getEpgUrl } from "../lib/epgSettings";
import type { EpgResult } from "../types/tvbox";

interface LiveEpgPanelProps {
  /** 当前频道名，用于匹配节目单。 */
  channelName: string;
  /** 线路 / 频道切换时变化，触发重新拉取。 */
  reloadKey?: string;
}

/** 本地日期 `YYYY-MM-DD`：节目单只取当天，避免把整份 2000+ 条节目都渲染出来。 */
function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 把 ISO 时间尽力显示成 HH:MM（本地时区已由 Python 换算过）。 */
function formatTime(iso: string): string {
  const match = iso.match(/T(\d{2}):(\d{2})/);
  if (match) {
    return `${match[1]}:${match[2]}`;
  }
  const fallback = iso.match(/(\d{2}):(\d{2})/);
  return fallback ? `${fallback[1]}:${fallback[2]}` : iso;
}

/** 节目是否正在进行（start ≤ now < stop；无 stop 时视为 2 小时内）。 */
function isOnAir(program: EpgResult["programs"][number]): boolean {
  const start = Date.parse(program.start);
  if (Number.isNaN(start)) {
    return false;
  }
  const now = Date.now();
  if (start > now) {
    return false;
  }
  if (program.stop) {
    const stop = Date.parse(program.stop);
    if (!Number.isNaN(stop) && stop > now) {
      return true;
    }
    return false;
  }
  return now - start < 2 * 3600 * 1000;
}

/** 直播态节目单：按频道名拉取 XMLTV 并高亮当前正在播放的节目。 */
export default function LiveEpgPanel({ channelName, reloadKey }: LiveEpgPanelProps) {
  const [data, setData] = useState<EpgResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /** 节目列表容器：加载完要把「正在播」那条滚到视野中间。 */
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    const name = channelName.trim();
    if (!name) {
      return;
    }
    let alive = true;
    const run = async () => {
      setLoading(true);
      setError("");
      try {
        const result = await api.liveEpg(getEpgUrl(), name, today());
        if (alive) {
          setData(result);
        }
      } catch (err) {
        if (alive) {
          setError(errorMessage(err));
        }
      } finally {
        if (alive) {
          setLoading(false);
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [channelName, reloadKey]);

  /**
   * 滚动到「正在播」。
   *
   * 默认节目单是整天的（央视 30+ 条），列表又只有 300px 高——不滚的话用户
   * 看到的永远是凌晨那几条，反而以为节目单不对。用父容器的 scrollTop 而不是
   * `scrollIntoView`，后者会连带把整个页面滚走。
   */
  useEffect(() => {
    const list = listRef.current;
    const now = list?.querySelector<HTMLElement>(".epg-item.is-now");
    if (!list || !now) {
      return;
    }
    list.scrollTop = Math.max(0, now.offsetTop - list.clientHeight / 2 + now.clientHeight / 2);
  }, [data]);

  if (!channelName.trim()) {
    return null;
  }

  return (
    <div className="live-epg">
      <h2 className="section-title live-epg__title">
        <ChannelLogo name={channelName} size={20} />
        节目单 · {channelName}
      </h2>
      {loading ? <p className="settings-line">加载节目单…</p> : null}
      {error ? <p className="tip tip--err">{error}</p> : null}
      {!loading && !error && data ? (
        data.programs.length === 0 ? (
          <p className="settings-line">未找到该频道的节目单数据。</p>
        ) : (
          <ul className="epg-list" ref={listRef}>
            {data.programs.map((program, index) => {
              const now = isOnAir(program);
              return (
                <li key={`${program.start}-${index}`} className={now ? "epg-item is-now" : "epg-item"}>
                  <span className="epg-time">{formatTime(program.start)}</span>
                  <div className="epg-body">
                    <span className="epg-title">
                      {program.title}
                      {now ? <span className="epg-now">正在播出</span> : null}
                    </span>
                    {program.desc ? <span className="epg-desc">{program.desc}</span> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </div>
  );
}
