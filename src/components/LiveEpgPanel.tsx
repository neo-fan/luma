import { useEffect, useRef, useState } from "react";
import ChannelLogo from "./ChannelLogo";
import Icon from "./Icon";
import { api, errorMessage } from "../lib/invoke";
import { getEpgUrl } from "../lib/epgSettings";
import type { EpgResult } from "../types/tvbox";

interface LiveEpgPanelProps {
  /** 当前频道名，用于匹配节目单。 */
  channelName: string;
  /** 线路 / 频道切换时变化，触发重新拉取。 */
  reloadKey?: string;
  /**
   * 「此刻正在播的节目名」上报（空串 = 没有数据）。
   *
   * 频道信息条已经显示台名，下面这条节目就是它最该有的第二行信息；节目单
   * 面板自己也知道，但它在信息条下方，只能由这里把结论往上递。
   */
  onNow?: (title: string) => void;
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
export default function LiveEpgPanel({
  channelName,
  reloadKey,
  onNow,
}: LiveEpgPanelProps) {
  const [data, setData] = useState<EpgResult | null>(null);
  /**
   * 默认收起。
   *
   * 直播的主体是画面：整天节目单展开时高度能顶到 400px，把 16:9 的画面挤成
   * 一条；而「现在在播什么」这一条信息 90% 的时候已经够了。收起态在标题行
   * 直接显示当前节目，想看后面还有什么再展开——只占一行，想开就开。
   */
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /** 节目列表容器：加载完要把「正在播」那条滚到视野中间。 */
  const listRef = useRef<HTMLUListElement | null>(null);
  /** 回调放 ref：它的身份每次渲染都变，不该让节目单 effect 重跑一次。 */
  const onNowRef = useRef(onNow);
  onNowRef.current = onNow;

  useEffect(() => {
    const name = channelName.trim();
    if (!name) {
      return;
    }
    // 换台瞬间先清掉上一台的节目，别让信息条显示「新台在播旧台的节目」。
    setData(null);
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
   *
   * ⚠️ 不能用 `now.offsetTop`：`<li>` 的 offsetParent 是最近的有定位祖先，
   * 不一定是 `.epg-list`（卡片有 position 就会算错），实测会停在错误位置。
   * 统一用相对矩形换算，并把当前节目放到视口上方 1/3 处（上下都留上下文）。
   */
  useEffect(() => {
    const list = listRef.current;
    const now = list?.querySelector<HTMLElement>(".epg-item.is-now");
    if (!list || !now) {
      return;
    }
    const box = list.getBoundingClientRect();
    const item = now.getBoundingClientRect();
    if (item.top >= box.top && item.bottom <= box.bottom) {
      // 已经在视野里（例如列表本身不满一屏）：不要为了「居中」硬跳一下。
      return;
    }
    list.scrollTop += item.top - box.top - box.height / 3;
  }, [data]);

  const nowTitle = data?.programs.find(isOnAir)?.title ?? "";

  useEffect(() => {
    onNowRef.current?.(nowTitle);
  }, [nowTitle]);

  if (!channelName.trim()) {
    return null;
  }

  return (
    <div
      className={expanded ? "live-epg is-expanded" : "live-epg is-collapsed"}
    >
      {/* 标题行就是折叠开关：收起时把「正在播」写在这一行里，信息不丢；
          展开后让位给完整时间轴。 */}
      <button
        type="button"
        className="live-epg__head"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        title={expanded ? "收起节目单" : "展开完整节目单"}
      >
        <ChannelLogo name={channelName} size={20} />
        <span className="live-epg__name">节目单 · {channelName}</span>
        {!expanded && nowTitle ? (
          <span className="live-epg__now">{nowTitle}</span>
        ) : null}
        <Icon name="chevron" size={14} className="live-epg__caret" />
      </button>
      {loading ? <p className="settings-line">加载节目单…</p> : null}
      {error ? <p className="tip tip--err">{error}</p> : null}
      {!loading && !error && data ? (
        data.programs.length === 0 ? (
          <p className="settings-line">未找到该频道的节目单数据。</p>
        ) : expanded ? (
          <ul className="epg-list" ref={listRef}>
            {data.programs.map((program, index) => {
              const now = isOnAir(program);
              return (
                <li
                  key={`${program.start}-${index}`}
                  className={now ? "epg-item is-now" : "epg-item"}
                >
                  <span className="epg-time">{formatTime(program.start)}</span>
                  <div className="epg-body">
                    <span className="epg-title">
                      {program.title}
                      {now ? <span className="epg-now">正在播出</span> : null}
                    </span>
                    {program.desc ? (
                      <span className="epg-desc">{program.desc}</span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null
      ) : null}
    </div>
  );
}
