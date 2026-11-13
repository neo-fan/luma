import { useEffect, useState } from "react";
import { api, errorMessage } from "../lib/invoke";
import { getEpgUrl } from "../lib/epgSettings";
import type { EpgResult } from "../types/tvbox";

interface LiveEpgPanelProps {
  /** 当前频道名，用于匹配节目单。 */
  channelName: string;
  /** 线路 / 频道切换时变化，触发重新拉取。 */
  reloadKey?: string;
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
        const result = await api.liveEpg(getEpgUrl(), name);
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

  if (!channelName.trim()) {
    return null;
  }

  return (
    <div className="live-epg">
      <h2 className="section-title">节目单 · {channelName}</h2>
      {loading ? <p className="settings-line">加载节目单…</p> : null}
      {error ? <p className="tip tip--err">{error}</p> : null}
      {!loading && !error && data ? (
        data.programs.length === 0 ? (
          <p className="settings-line">未找到该频道的节目单数据。</p>
        ) : (
          <ul className="epg-list">
            {data.programs.map((program, index) => (
              <li
                key={`${program.start}-${index}`}
                className={isOnAir(program) ? "epg-item is-now" : "epg-item"}
              >
                <span className="epg-time">{formatTime(program.start)}</span>
                <span className="epg-title">{program.title}</span>
                {program.desc ? <span className="epg-desc">{program.desc}</span> : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
