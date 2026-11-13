import { useEffect, useMemo, useRef, useState, useDeferredValue } from "react";
import type { Navigate } from "../lib/nav";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import IconButton from "../components/IconButton";
import AppSelect from "../components/AppSelect";
import Spinner from "../components/Spinner";
import { api, errorMessage } from "../lib/invoke";
import { usePageState } from "../lib/usePageState";
import { getLiveLine, setLiveLine } from "../lib/liveMemory";
import ChannelLogo from "../components/ChannelLogo";
import { getEpgUrl } from "../lib/epgSettings";
import type { LiveChannel, LiveGroup, LiveSource } from "../types/tvbox";

interface LivePageProps {
  lives: LiveSource[];
  navigate: Navigate;
}

/** 分组容器型源（只有 `channels`，没有 `url`）直接展开，无需请求网络。 */
function expandChannels(source: LiveSource): LiveGroup[] {
  const channels = (source.channels ?? [])
    .map((channel) => {
      // 容器源的 urls 本身就是多线路；同一频道不再拍平成多个 chip。
      const lines = Array.from(
        new Set((channel.urls ?? []).filter((url) => /^https?:\/\//i.test(url))),
      );
      if (lines.length === 0) {
        return null;
      }
      return { name: channel.name || lines[0], url: lines[0], lines };
    })
    .filter((channel): channel is LiveChannel => channel !== null);
  if (channels.length === 0) {
    return [];
  }
  return [{ name: source.group || source.name || "未分组", channels }];
}

/** 确保每条频道都带 `lines`：后端发 `urls`，前端按线路处理前归一化一次。 */
function normalizeGroups(groups: LiveGroup[]): LiveGroup[] {
  return groups.map((group) => ({
    ...group,
    channels: group.channels.map((channel) => {
      const lines = channel.lines?.length
        ? channel.lines
        : Array.from(new Set((channel.urls ?? []).filter(Boolean)));
      const resolved = lines.length > 0 ? lines : [channel.url];
      return { ...channel, lines: resolved, url: resolved[0] };
    }),
  }));
}

/** 有列表地址，或能从分组容器里展开出至少一个可播放频道。 */
function isListable(source: LiveSource): boolean {
  if (source.url) {
    return true;
  }
  return expandChannels(source).length > 0;
}

/** 折叠态单组分批上限；展开后再放宽到 EXPANDED_LIMIT，避免一次性塞进几千节点。 */
const CHANNEL_LIMIT = 300;
const EXPANDED_LIMIT = 1000;
/** 直播源切换防抖：与首页站点切换一致的 300ms，连切只命中最后一项。 */
const SWITCH_DEBOUNCE_MS = 300;

/** 直播：配置里的 lives[] 列表 → 分组频道 → 播放。 */
export default function LivePage({ lives, navigate }: LivePageProps) {
  const [activeIndex, setActiveIndex] = usePageState<number>("live:index", 0);
  const [keyword, setKeyword] = usePageState<string>("live:keyword", "");
  // 关键词用于过滤；用 deferred 让输入框在几千个频道下也保持跟手，
  // 重渲染交给 React 在低优先级调度，而不是每次按键同步全量过滤。
  const deferredKeyword = useDeferredValue(keyword);
  const pattern = deferredKeyword.trim().toLowerCase();

  // 重新导入配置导致源数量变少时，旧索引可能越界；钳到 0 避免 lives[idx] 为 undefined。
  useEffect(() => {
    if (activeIndex > 0 && activeIndex >= lives.length) {
      setActiveIndex(0);
    }
  }, [lives.length, activeIndex, setActiveIndex]);

  const active = lives[activeIndex];
  const sourceUrl = active?.url ?? "";
  // 源标识：既用于列表缓存键，也用于线路偏好记忆键，保持一致。
  const sourceKey = sourceUrl || `container:${activeIndex}`;
  // m3u 列表按源地址保留，播完一个频道返回时不再重新下载解析几千行。
  const [groups, setGroups] = usePageState<LiveGroup[]>(
    `live:${sourceKey}:groups`,
    [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // 一次性强制刷新信号：true 时穿透缓存重新拉取，拉完即复位，不破坏切源缓存。
  const [forceReload, setForceReload] = useState(false);
  // 用户主动展开的分组（按组名），默认只渲染前 CHANNEL_LIMIT 个避免 DOM 爆炸。
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // 当前选中的分组（吸顶标签栏单组视图）；null 表示尚未落到某组（首次/切源时重置）。
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  // 切源防抖：下拉即时显示 draftIndex，300ms 后才真正切换 activeIndex 并重拉。
  const [draftIndex, setDraftIndex] = useState(activeIndex);
  const switchTimerRef = useRef<number | null>(null);

  // 当前分组失效（首次加载、切源后、重新导入）时，默认落到第一个分组。
  useEffect(() => {
    if (!activeGroup || !groups.some((group) => group.name === activeGroup)) {
      setActiveGroup(groups[0]?.name ?? null);
    }
  }, [groups, activeGroup]);

  // activeIndex 被外部钳制（重新导入源变少）时，下拉显示同步收敛，避免错位。
  useEffect(() => {
    setDraftIndex(activeIndex);
  }, [activeIndex]);

  /**
   * 预热节目单（只下载不解析）。
   *
   * 默认节目单是 7.6 MB 的 XMLTV，冷缓存要十几秒；用户点开频道才发现
   * 「加载节目单…」会以为是坏的。进直播页就先在后台把它拉下来（Rust 侧缓存
   * 3 小时），点频道时只剩 ~0.5s 的解析。失败静默——节目单不是主链路。
   */
  useEffect(() => {
    void api.liveEpgWarm(getEpgUrl()).catch(() => {
      /* 预热失败不影响直播；真正打开节目单时还会再试一次 */
    });
  }, []);

  // 卸载时清掉挂起的切换定时器，避免对已卸载组件 setState。
  useEffect(
    () => () => {
      if (switchTimerRef.current !== null) {
        window.clearTimeout(switchTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!active) {
      setGroups([]);
      return;
    }
    // 已有缓存且未要求强制刷新：直接复用（切回已加载过的源不再重新下载）。
    if (groups.length > 0 && !forceReload) {
      return;
    }
    if (!sourceUrl) {
      // 分组容器：本地展开即可，别拿 undefined 去请求接口。
      const local = expandChannels(active);
      setGroups(normalizeGroups(local));
      setLoading(false);
      setError(local.length === 0 ? "该直播源是分组容器，没有可直接播放的地址。" : "");
      setForceReload(false);
      return;
    }
    let alive = true;
    const run = async () => {
      setLoading(true);
      setError("");
      try {
        const result = await api.liveParse(sourceUrl, active.ua, forceReload);
        if (alive) {
          setGroups(normalizeGroups(result.groups ?? []));
        }
      } catch (err) {
        if (alive) {
          setGroups([]);
          setError(`直播列表加载失败：${errorMessage(err)}`);
        }
      } finally {
        if (alive) {
          setLoading(false);
          setForceReload(false);
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [active, groups, forceReload]);

  // 每个源是否可列：只在 lives 变化时重算，过滤输入不触发。
  const listable = useMemo(() => lives.map(isListable), [lives]);

  // 过滤结果：pattern 不变就不重算（loading/error 等状态变化也不会全量重过滤）。
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

  const total = useMemo(
    () => groups.reduce((sum, group) => sum + group.channels.length, 0),
    [groups],
  );

  if (lives.length === 0) {
    return (
      <section className="page">
        <header className="page-head">
          <h1 className="page-title">直播</h1>
        </header>
        <Empty
          title="当前配置没有直播源"
          description="导入带 lives[] 的配置后，这里会列出直播分组与频道。"
        />
      </section>
    );
  }

  const toggleGroup = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });

  // 源切换：立即更新下拉显示，300ms 后才真正切换并重拉列表。
  // 快速 A→B→C 只请求 C；选回当前源直接取消，不重拉（复用 pageState 缓存）。
  const switchSource = (next: number) => {
    setDraftIndex(next);
    if (switchTimerRef.current !== null) {
      window.clearTimeout(switchTimerRef.current);
    }
    switchTimerRef.current = window.setTimeout(() => {
      switchTimerRef.current = null;
      if (next === activeIndex) {
        return;
      }
      setActiveIndex(next);
      // 切源时收起之前的展开、清空筛选、回到首分组，
      // 避免带着旧源的筛选词落到新源却显示「没有匹配的频道」，误以为没切过去。
      setExpanded(new Set());
      setKeyword("");
      setActiveGroup(null);
    }, SWITCH_DEBOUNCE_MS);
  };

  // 播放某频道指定线路：钳制越界序号、记住选择、把整组线路带给播放页。
  const play = (channel: LiveChannel, lineIndex: number) => {
    const count = channel.lines.length;
    const idx = ((lineIndex % count) + count) % count;
    setLiveLine(sourceKey, channel.name, idx);
    navigate({
      name: "player",
      siteKey: "live",
      vodId: channel.name,
      vodName: channel.name,
      episodeName: channel.name,
      playUrl: channel.lines[idx],
      // lives[].ua 只用于拉列表；播放 CDN 往往也要同一个 UA。
      ua: active?.ua,
      liveLines: channel.lines,
      liveLine: idx,
      liveSource: sourceKey,
    });
  };

  // 渲染单个分组的标题 + 频道 chip 行；搜索态跨组与单组视图共用，避免重复。
  const renderGroup = (group: LiveGroup, isOpen: boolean) => {
    const limit = isOpen ? EXPANDED_LIMIT : CHANNEL_LIMIT;
    const shown = group.channels.slice(0, limit);
    const overflow = group.channels.length > limit;
    return (
      <div className="section" key={group.name}>
        <h2 className="section-title">
          {group.name}
          {!pattern && overflow ? (
            <button
              type="button"
              className="section-title__more"
              onClick={() => toggleGroup(group.name)}
            >
              {isOpen ? "收起" : `展开全部 ${group.channels.length} 个`}
            </button>
          ) : null}
          {isOpen && overflow && group.channels.length > EXPANDED_LIMIT ? (
            <span className="page-meta" style={{ marginLeft: 8, fontWeight: "var(--fw-regular)" }}>
              仅显示前 {EXPANDED_LIMIT} 个
            </span>
          ) : null}
        </h2>
        <div className="chip-row">
          {shown.map((channel) => {
            const key = `${group.name}::${channel.name}`;
            const multi = channel.lines.length > 1;
            // 点开直接播：默认第一条线路，或该频道上次用过的线路（越界钳制）。
            // 手动切线路放在播放页的 .live-switch，列表侧不再弹选择器。
            const remembered = multi
              ? Math.min(getLiveLine(sourceKey, channel.name), channel.lines.length - 1)
              : 0;
            return (
              <span className="live-chip" key={key}>
                <button
                  type="button"
                  className="chip"
                  title={channel.lines[remembered]}
                  onClick={() => play(channel, remembered)}
                >
                  <ChannelLogo name={channel.name} logo={channel.logo} />
                  {channel.name}
                  {multi ? (
                    <span className="chip__badge" aria-hidden="true">
                      {channel.lines.length}
                    </span>
                  ) : null}
                </button>
              </span>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <section className="page">
      <header className="page-head">
        <div className="page-head__main">
          <h1 className="page-title">直播</h1>
          <AppSelect
            ariaLabel="选择直播源"
            value={String(draftIndex)}
            onChange={(value) => switchSource(Number(value))}
            options={lives.map((item, index) => ({
              value: String(index),
              label: (item.name || `源 ${index + 1}`) + (listable[index] ? "" : "（无列表）"),
              disabled: !listable[index],
              disabledHint: listable[index] ? undefined : "无列表",
            }))}
          />
          <span className="page-meta">{total > 0 ? `${total} 个频道` : "—"}</span>
        </div>
        <IconButton
          name="refresh"
          label="刷新"
          busy={loading}
          disabled={loading}
          onClick={() => setForceReload(true)}
        />
      </header>

      <div className="search-bar">
        <input
          className="input"
          type="text"
          value={keyword}
          placeholder="按频道名筛选"
          onChange={(event) => setKeyword(event.target.value)}
        />
      </div>

      {error ? <ErrorBar message={error} onRetry={() => setForceReload(true)} /> : null}
      {loading ? <Spinner label="正在读取直播列表…" /> : null}
      {!loading && !error && visible.length === 0 ? (
        <Empty title="没有匹配的频道" description="换一个直播源或清空筛选关键字。" />
      ) : null}

      {/* 分组吸顶标签栏：单组视图下在分组间快速切换，避免全部分组堆成一长页。 */}
      {!pattern && groups.length > 0 ? (
        <div className="group-tabs" role="tablist" aria-label="直播分组">
          {groups.map((group) => (
            <button
              key={group.name}
              type="button"
              role="tab"
              aria-selected={group.name === activeGroup}
              className={group.name === activeGroup ? "chip is-active" : "chip"}
              onClick={() => setActiveGroup(group.name)}
            >
              {group.name}
              <span className="chip__count">{group.channels.length}</span>
            </button>
          ))}
        </div>
      ) : null}

      {/* 搜索态：跨所有分组展示匹配结果；否则只渲染当前选中的单组。 */}
      {pattern
        ? visible.map((group) => renderGroup(group, true))
        : activeGroup && groups.some((group) => group.name === activeGroup)
          ? renderGroup(
              groups.find((group) => group.name === activeGroup)!,
              expanded.has(activeGroup),
            )
          : null}
    </section>
  );
}
