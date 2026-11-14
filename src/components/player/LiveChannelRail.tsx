import { useEffect, useMemo, useRef, useState } from "react";
import ChannelLogo from "../ChannelLogo";
import Spinner from "../Spinner";
import { errorMessage } from "../../lib/invoke";
import { getLiveLine } from "../../lib/liveMemory";
import { loadLiveGroups } from "../../lib/liveChannels";
import type { LiveChannel, LiveGroup } from "../../types/tvbox";

interface LiveChannelRailProps {
  /** 当前正在播的频道名：用于高亮与自动滚动。 */
  currentName: string;
  /** 直播源标识（LivePage 传入的同一个 key），用于读线路记忆。 */
  sourceKey: string;
  /** 选中某频道的某条线路。 */
  onPick: (channel: LiveChannel, lineIndex: number) => void;
}

/** 记住的是线路序号，源里线路数量可能变少，用前先钳制。 */
function pickLine(sourceKey: string, channel: LiveChannel): number {
  const remembered = getLiveLine(sourceKey, channel.name);
  return Math.min(Math.max(remembered, 0), Math.max(channel.lines.length - 1, 0));
}

/**
 * 直播播放页左侧频道栏。
 *
 * 直播和点播的浏览方式不同：点播是「挑一部剧看完」，直播是「换台」——用户
 * 在播放页里最常做的动作是切下一个频道，回列表页再点进来每次要重走一遍
 * 滚动位置。把频道列表钉在左边，换台只差一次点击。
 *
 * 结构上**只有一层**：所有分组首尾相连成一个长列表，分组名是吸顶小标题，
 * 直接往下滚就能扫完全部频道（不做「先选组、再看组内」的二次筛选——用户
 * 反馈那样左栏一半是空的，还得先做一次选择）。
 *
 * 数据来自 `lib/liveChannels`（LivePage 解析后 prime 的进程内缓存），命中缓存
 * 时零 IPC；缓存为空（刷新直达播放页）才按记住的源地址重拉一次。
 */
export default function LiveChannelRail({
  currentName,
  sourceKey,
  onPick,
}: LiveChannelRailProps) {
  const [groups, setGroups] = useState<LiveGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    void loadLiveGroups(sourceKey)
      .then((next) => {
        if (alive) {
          setGroups(next);
        }
      })
      .catch((err) => {
        if (alive) {
          setGroups([]);
          setError(errorMessage(err));
        }
      })
      .finally(() => {
        if (alive) {
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [sourceKey]);

  const pattern = keyword.trim().toLowerCase();

  const visible = useMemo(() => {
    if (!pattern) {
      return groups;
    }
    return groups
      .map((group) => ({
        ...group,
        channels: group.channels.filter((item) => item.name.toLowerCase().includes(pattern)),
      }))
      .filter((group) => group.channels.length > 0);
  }, [groups, pattern]);

  /**
   * 高亮项滚进视野。
   *
   * 换台后侧栏会随 PlayerPage 重挂载回到顶部，用户看不到「现在播的是哪个」，
   * 也就没法接着往下换。用相对矩形换算（`offsetTop` 的 offsetParent 不一定是
   * 滚动容器），已可见则不动，避免每次渲染都抖一下。
   */
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }
    const node = scroller.querySelector<HTMLElement>(".live-rail__item.is-active");
    if (!node) {
      return;
    }
    const box = scroller.getBoundingClientRect();
    const item = node.getBoundingClientRect();
    if (item.top < box.top || item.bottom > box.bottom) {
      scroller.scrollTop += item.top - box.top - box.height / 3;
    }
  }, [groups, currentName]);

  const total = useMemo(
    () => groups.reduce((sum, group) => sum + group.channels.length, 0),
    [groups],
  );

  return (
    <div className="live-rail">
      <div className="live-rail__head">
        <input
          className="input live-rail__search"
          type="search"
          value={keyword}
          placeholder="搜索频道"
          aria-label="搜索频道"
          onChange={(event) => setKeyword(event.target.value)}
        />
        <span className="live-rail__count">{total > 0 ? `${total} 台` : "—"}</span>
      </div>

      <div className="live-rail__scroll" ref={scrollerRef}>
        {loading ? <Spinner label="读取频道…" /> : null}
        {error ? <p className="tip tip--err">{error}</p> : null}
        {!loading && !error && visible.length === 0 ? (
          <p className="settings-line">没有匹配的频道。</p>
        ) : null}
        {visible.map((group) => (
          <div className="live-rail__group" key={group.name}>
            <h3 className="live-rail__group-title">
              {group.name}
              <span className="live-rail__group-num">{group.channels.length}</span>
            </h3>
            {group.channels.map((channel) => {
              const active = channel.name === currentName;
              return (
                <button
                  key={`${group.name}::${channel.name}`}
                  type="button"
                  className={active ? "live-rail__item is-active" : "live-rail__item"}
                  aria-current={active ? "true" : undefined}
                  title={channel.name}
                  onClick={() => onPick(channel, pickLine(sourceKey, channel))}
                >
                  <ChannelLogo name={channel.name} logo={channel.logo} size={18} />
                  <span className="live-rail__name">{channel.name}</span>
                  {channel.lines.length > 1 ? (
                    <span className="live-rail__badge" aria-hidden="true">
                      {channel.lines.length}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
