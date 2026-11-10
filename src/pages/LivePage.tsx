import { useEffect, useState } from "react";
import type { Navigate } from "../App";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import Spinner from "../components/Spinner";
import { api, errorMessage } from "../lib/invoke";
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

/** 单个分组一次渲染的上限：真实配置的第一条源就有 5700 个频道。 */
const CHANNEL_LIMIT = 300;

/** 直播：配置里的 lives[] 列表 → 分组频道 → 播放。 */
export default function LivePage({ lives, navigate }: LivePageProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [groups, setGroups] = useState<LiveGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [keyword, setKeyword] = useState("");

  const active = lives[activeIndex];

  useEffect(() => {
    if (!active) {
      setGroups([]);
      return;
    }
    const sourceUrl = active.url;
    if (!sourceUrl) {
      // 分组容器：本地展开即可，别拿 undefined 去请求接口。
      const local = expandChannels(active);
      setGroups(local);
      setLoading(false);
      setError(
        local.length === 0
          ? "该直播源是分组容器，没有可直接播放的地址。"
          : "",
      );
      return;
    }
    let alive = true;
    const run = async () => {
      setLoading(true);
      setError("");
      try {
        const result = await api.liveParse(sourceUrl, active.ua);
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
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [active, reload]);

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

  const pattern = keyword.trim().toLowerCase();
  const visible = groups
    .map((group) => ({
      ...group,
      channels: pattern
        ? group.channels.filter((item) => item.name.toLowerCase().includes(pattern))
        : group.channels,
    }))
    .filter((group) => group.channels.length > 0);

  const total = groups.reduce((sum, group) => sum + group.channels.length, 0);

  return (
    <section className="page">
      <header className="page-head">
        <div className="page-head__main">
          <h1 className="page-title">直播</h1>
          <span className="page-meta">{total > 0 ? `${total} 个频道` : "—"}</span>
        </div>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => setReload((value) => value + 1)}
          disabled={loading}
        >
          刷新
        </button>
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
        {lives.map((item, index) => {
          // Container sources can hold thousands of channels; `isListable`
          // expands them, so compute it once per chip rather than twice.
          const listable = isListable(item);
          return (
            <button
              key={`${item.name}-${index}`}
              type="button"
              className={index === activeIndex ? "chip is-active" : "chip"}
              disabled={!listable}
              title={listable ? undefined : "该源没有列表地址（分组容器且无可用频道）"}
              onClick={() => setActiveIndex(index)}
            >
              {item.name || `源 ${index + 1}`}
            </button>
          );
        })}
      </div>

      {error ? <ErrorBar message={error} onRetry={() => setReload((value) => value + 1)} /> : null}
      {loading ? <Spinner label="正在读取直播列表…" /> : null}
      {!loading && !error && visible.length === 0 ? (
        <Empty title="没有匹配的频道" description="换一个直播源或清空筛选关键字。" />
      ) : null}

      {visible.map((group) => (
        <div className="section" key={group.name}>
          <h2 className="section-title">
            {group.name}
            {group.channels.length > CHANNEL_LIMIT ? (
              <span className="page-meta" style={{ marginLeft: 8, fontWeight: 400 }}>
                共 {group.channels.length} 个，仅显示前 {CHANNEL_LIMIT} 个
              </span>
            ) : null}
          </h2>
          <div className="chip-row">
            {group.channels.slice(0, CHANNEL_LIMIT).map((channel) => (
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
                    ua: active.ua,
                  })
                }
              >
                {channel.name}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
