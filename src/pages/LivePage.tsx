import { useEffect, useState } from "react";
import type { Navigate } from "../App";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import Spinner from "../components/Spinner";
import { api, toAppError } from "../lib/invoke";
import type { LiveGroup, LiveSource } from "../types/tvbox";

interface LivePageProps {
  lives: LiveSource[];
  navigate: Navigate;
}

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
    let alive = true;
    const run = async () => {
      setLoading(true);
      setError("");
      try {
        const result = await api.liveParse(active.url, active.ua);
        if (alive) {
          setGroups(result.groups ?? []);
        }
      } catch (err) {
        if (alive) {
          setGroups([]);
          setError(`直播列表加载失败：${toAppError(err).message}`);
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
        {lives.map((item, index) => (
          <button
            key={`${item.name}-${index}`}
            type="button"
            className={index === activeIndex ? "chip is-active" : "chip"}
            onClick={() => setActiveIndex(index)}
          >
            {item.name}
          </button>
        ))}
      </div>

      {error ? <ErrorBar message={error} onRetry={() => setReload((value) => value + 1)} /> : null}
      {loading ? <Spinner label="正在读取直播列表…" /> : null}
      {!loading && !error && visible.length === 0 ? (
        <Empty title="没有匹配的频道" description="换一个直播源或清空筛选关键字。" />
      ) : null}

      {visible.map((group) => (
        <div className="section" key={group.name}>
          <h2 className="section-title">{group.name}</h2>
          <div className="chip-row">
            {group.channels.map((channel) => (
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
