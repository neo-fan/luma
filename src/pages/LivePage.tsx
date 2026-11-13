import { useEffect, useMemo, useState, useDeferredValue } from "react";
import type { Navigate } from "../App";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import IconButton from "../components/IconButton";
import Spinner from "../components/Spinner";
import { api, errorMessage } from "../lib/invoke";
import { usePageState } from "../lib/usePageState";
import type { LiveGroup, LiveSource } from "../types/tvbox";

interface LivePageProps {
  lives: LiveSource[];
  navigate: Navigate;
}

/** 分组容器型源（只有 `channels`，没有 `url`）直接展开，无需请求网络。 */
function expandChannels(source: LiveSource): LiveGroup[] {
  const channels = (source.channels ?? []).flatMap((channel) =>
    (channel.urls ?? [])
      // `proxy://do=live...` 这类内部伪协议本机播放器无法处理，直接略过。
      .filter((url) => /^https?:\/\//i.test(url))
      .map((url) => ({ name: channel.name || url, url })),
  );
  if (channels.length === 0) {
    return [];
  }
  return [{ name: source.group || source.name || "未分组", channels }];
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
  // m3u 列表按源地址保留，播完一个频道返回时不再重新下载解析几千行。
  const [groups, setGroups] = usePageState<LiveGroup[]>(
    `live:${sourceUrl || `container:${activeIndex}`}:groups`,
    [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // 一次性强制刷新信号：true 时穿透缓存重新拉取，拉完即复位，不破坏切源缓存。
  const [forceReload, setForceReload] = useState(false);
  // 用户主动展开的分组（按组名），默认只渲染前 CHANNEL_LIMIT 个避免 DOM 爆炸。
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

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
      setGroups(local);
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
          setGroups(result.groups ?? []);
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

  return (
    <section className="page">
      <header className="page-head">
        <div className="page-head__main">
          <h1 className="page-title">直播</h1>
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

      <div className="chip-row">
        {lives.map((item, index) => (
          <button
            key={`${item.name}-${index}`}
            type="button"
            className={index === activeIndex ? "chip is-active" : "chip"}
            disabled={!listable[index]}
            title={listable[index] ? undefined : "该源没有列表地址（分组容器且无可用频道）"}
            onClick={() => {
              setActiveIndex(index);
              // 切源时收起之前的展开，避免回到长列表顶部还带着旧展开态。
              setExpanded(new Set());
            }}
          >
            {item.name || `源 ${index + 1}`}
          </button>
        ))}
      </div>

      {error ? <ErrorBar message={error} onRetry={() => setForceReload(true)} /> : null}
      {loading ? <Spinner label="正在读取直播列表…" /> : null}
      {!loading && !error && visible.length === 0 ? (
        <Empty title="没有匹配的频道" description="换一个直播源或清空筛选关键字。" />
      ) : null}

      {visible.map((group) => {
        const isOpen = expanded.has(group.name) || Boolean(pattern);
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
                <span className="page-meta" style={{ marginLeft: 8, fontWeight: 400 }}>
                  仅显示前 {EXPANDED_LIMIT} 个
                </span>
              ) : null}
            </h2>
            <div className="chip-row">
              {shown.map((channel) => (
                <button
                  key={`${group.name}-${channel.name}-${channel.url}`}
                  type="button"
                  className="chip"
                  title={channel.url}
                  onClick={() =>
                    navigate({
                      name: "player",
                      siteKey: "live",
                      vodId: channel.url,
                      vodName: channel.name,
                      episodeName: channel.name,
                      playUrl: channel.url,
                      // lives[].ua 只用于拉列表；播放 CDN 往往也要同一个 UA。
                      ua: active?.ua,
                    })
                  }
                >
                  {channel.name}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
