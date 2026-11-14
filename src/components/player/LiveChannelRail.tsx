import { useEffect, useMemo, useRef, useState } from "react";
import ChannelLogo from "../ChannelLogo";
import Icon from "../Icon";
import IconButton from "../IconButton";
import type { LiveChannel, LiveGroup } from "../../types/tvbox";

interface LiveChannelRailProps {
  groups: LiveGroup[];
  loading: boolean;
  error: string;
  /** 重新拉取 m3u（穿透列表缓存）。 */
  onRefresh: () => void;
  /** 当前正在播的频道名：用于高亮与自动滚动。 */
  currentName: string;
  /** 选中某频道（用哪个线路由调用方按该频道的记忆决定）。 */
  onPick: (channel: LiveChannel) => void;
  /** 上一台 / 下一台：按全部频道展平后的顺序，越界循环。 */
  onStep: (delta: 1 | -1) => void;
  /** 当前频道在展平列表里的序号（1 基）；0 表示还没选中。 */
  position: number;
  total: number;
}

/**
 * 直播播放页左侧频道目录。
 *
 * 直播是「换台」而不是「挑一部看完」：用户最常做的动作是切下一个台，回列表页
 * 再点进来每次都要重走一遍滚动位置。所以目录常驻在播放器左边，换台只差一次
 * 点击，底部再给一条遥控器式的「上一台 / 下一台」。
 *
 * 结构上**只有一层**：所有分组首尾相连成一个长列表，分组名是吸顶小标题，
 * 直接往下滚就能扫完全部频道——不做「先选组、再看组内」的二次筛选（那样
 * 左栏一半是空的，还得先做一次选择）。
 *
 * 数据由调用方加载（`useLiveCatalog`），这里只管筛选、折叠、滚动与高亮。
 */
export default function LiveChannelRail({
  groups,
  loading,
  error,
  onRefresh,
  currentName,
  onPick,
  onStep,
  position,
  total,
}: LiveChannelRailProps) {
  const [keyword, setKeyword] = useState("");
  /** 手动折叠的分组名；搜索态忽略折叠（否则搜出来的台被折叠藏起来）。 */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const scrollerRef = useRef<HTMLDivElement | null>(null);

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
   * 换台后目录会重新渲染，用户看不到「现在播的是哪个」，也就没法接着往下换。
   * 用相对矩形换算（`offsetTop` 的 offsetParent 不一定是滚动容器），已可见
   * 则不动，避免每次渲染都抖一下。
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

  const toggleGroup = (name: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });

  return (
    <aside className="live-rail" aria-label="频道列表">
      <div className="live-rail__head">
        <label className="live-rail__search">
          <Icon name="search" size={14} />
          <input
            className="live-rail__input"
            type="search"
            value={keyword}
            placeholder="搜索频道"
            aria-label="搜索频道"
            onChange={(event) => setKeyword(event.target.value)}
          />
        </label>
        <IconButton name="refresh" label="刷新频道列表" busy={loading} onClick={onRefresh} />
      </div>

      <div className="live-rail__scroll" ref={scrollerRef}>
        {loading ? <p className="live-rail__hint">正在读取频道…</p> : null}
        {error ? <p className="tip tip--err">{error}</p> : null}
        {!loading && !error && visible.length === 0 ? (
          <p className="live-rail__hint">
            {pattern ? "没有匹配的频道。" : "这个源里没有可播放的频道。"}
          </p>
        ) : null}
        {visible.map((group) => {
          const folded = !pattern && collapsed.has(group.name);
          return (
            <div className="live-rail__group" key={group.name}>
              <button
                type="button"
                className={folded ? "live-rail__group-title is-folded" : "live-rail__group-title"}
                aria-expanded={!folded}
                onClick={() => toggleGroup(group.name)}
                title={folded ? "展开分组" : "折叠分组"}
              >
                <span className="live-rail__group-name">{group.name}</span>
                <span className="live-rail__group-num">{group.channels.length}</span>
                <Icon name="chevron" size={12} className="live-rail__group-caret" />
              </button>
              {folded
                ? null
                : group.channels.map((channel) => {
                    const active = channel.name === currentName;
                    return (
                      <button
                        key={`${group.name}::${channel.name}`}
                        type="button"
                        className={active ? "live-rail__item is-active" : "live-rail__item"}
                        aria-current={active ? "true" : undefined}
                        title={channel.name}
                        onClick={() => onPick(channel)}
                      >
                        <ChannelLogo name={channel.name} logo={channel.logo} size={22} />
                        <span className="live-rail__name">{channel.name}</span>
                        {active ? (
                          <span className="live-rail__eq" aria-hidden="true">
                            <i />
                            <i />
                            <i />
                          </span>
                        ) : channel.lines.length > 1 ? (
                          <span className="live-rail__badge">{channel.lines.length} 路</span>
                        ) : null}
                      </button>
                    );
                  })}
            </div>
          );
        })}
      </div>

      {/* 遥控器式换台条：直播里最高频的动作给它一个固定位置，
          不用回列表里找「下一个是哪个台」。 */}
      <div className="live-rail__foot">
        <button
          type="button"
          className="live-rail__step"
          aria-label="上一个频道"
          disabled={total === 0}
          onClick={() => onStep(-1)}
        >
          <Icon name="back" size={16} />
        </button>
        <span className="live-rail__pos">
          <b>{position > 0 ? position : "—"}</b>
          <span className="live-rail__pos-sep">/</span>
          {total > 0 ? total : "—"}
        </span>
        <button
          type="button"
          className="live-rail__step"
          aria-label="下一个频道"
          disabled={total === 0}
          onClick={() => onStep(1)}
        >
          <Icon name="next" size={16} />
        </button>
      </div>
    </aside>
  );
}
