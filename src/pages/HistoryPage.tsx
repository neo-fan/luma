import { useEffect, useState } from "react";
import type { Navigate } from "../App";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import Spinner from "../components/Spinner";
import VodCard from "../components/VodCard";
import { api, errorMessage } from "../lib/invoke";
import { log } from "../lib/logger";
import { usePageState } from "../lib/usePageState";
import type { HistoryItem } from "../types/tvbox";

interface HistoryPageProps {
  navigate: Navigate;
}

/** 播放进度：拿不到时长时只显示已看时长。 */
function progressText(item: HistoryItem): string {
  const position = item.positionMs ?? 0;
  if (!item.durationMs || item.durationMs <= 0) {
    return position > 0 ? `已看 ${Math.round(position / 1000)} 秒` : "";
  }
  const percent = Math.min(99, Math.round((position / item.durationMs) * 100));
  return `已看 ${percent}%`;
}

/** 相对时间：历史列表里「3 小时前」比一串 ISO 更好扫。 */
function relativeTime(ms: number): string {
  if (!ms) {
    return "";
  }
  const diff = Date.now() - ms;
  if (diff < 60_000) {
    return "刚刚";
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)} 分钟前`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)} 小时前`;
  }
  if (diff < 7 * 86_400_000) {
    return `${Math.floor(diff / 86_400_000)} 天前`;
  }
  const date = new Date(ms);
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 历史页：最近观看的影片 + 进度，点开回到详情页继续播放。 */
export default function HistoryPage({ navigate }: HistoryPageProps) {
  // 与收藏页同一套策略：先直出上次的列表，再静默刷新，有数据时不闪 Spinner。
  const [items, setItems] = usePageState<HistoryItem[]>("history:items", []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      if (items.length === 0) {
        setLoading(true);
      }
      setError("");
      try {
        const list = await api.historyList();
        if (alive) {
          setItems(list);
        }
      } catch (err) {
        if (alive) {
          setItems([]);
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
    // items 故意不进依赖：只在挂载 / 手动刷新时读库，渲染写入不再触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  const remove = async (item: HistoryItem) => {
    const key = `${item.siteKey}-${item.vodId}`;
    if (busyKey) {
      return;
    }
    setBusyKey(key);
    setError("");
    try {
      await api.historyRemove(item.siteKey, item.vodId);
      setItems((list) =>
        list.filter((one) => !(one.siteKey === item.siteKey && one.vodId === item.vodId)),
      );
      log.info("history removed", { siteKey: item.siteKey, vodId: item.vodId });
    } catch (err) {
      setError(`删除历史失败：${errorMessage(err)}`);
    } finally {
      setBusyKey("");
    }
  };

  const clearAll = async () => {
    if (!window.confirm(`确定清空 ${items.length} 条观看历史吗？此操作不可恢复。`)) {
      return;
    }
    setError("");
    try {
      await api.historyClear();
      setItems([]);
      log.info("history cleared");
    } catch (err) {
      setError(`清空历史失败：${errorMessage(err)}`);
    }
  };

  return (
    <section className="page">
      <header className="page-head">
        <div className="page-head__main">
          <h1 className="page-title">历史</h1>
          <span className="page-meta">共 {items.length} 条</span>
        </div>
        {items.length > 0 ? (
          <button type="button" className="btn btn--ghost" onClick={() => void clearAll()}>
            清空历史
          </button>
        ) : null}
      </header>

      {error ? <ErrorBar message={error} onRetry={() => setReload((value) => value + 1)} /> : null}

      {loading && items.length === 0 ? <Spinner label="正在加载观看历史…" /> : null}

      {!loading && !error && items.length === 0 ? (
        <Empty
          title="还没有观看记录"
          description="播放任意影片后，这里会记录进度，方便下次接着看。"
          action={
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => navigate({ name: "home" })}
            >
              去逛逛
            </button>
          }
        />
      ) : null}

      {items.length > 0 ? (
        <div className="vod-grid">
          {items.map((item) => {
            const key = `${item.siteKey}-${item.vodId}`;
            const progress = progressText(item);
            const when = relativeTime(item.updatedAt);
            const sub = [item.siteName || item.siteKey, progress, when]
              .filter(Boolean)
              .join(" · ");
            return (
              <div className="fav-item" key={key}>
                <VodCard
                  title={item.name}
                  pic={item.pic}
                  remarks={item.remarks}
                  sub={sub}
                  onOpen={() =>
                    navigate({
                      name: "detail",
                      siteKey: item.siteKey,
                      vodId: item.vodId,
                      title: item.name,
                    })
                  }
                />
                <button
                  type="button"
                  className="fav-remove"
                  title="删除这条历史"
                  disabled={busyKey === key}
                  onClick={() => void remove(item)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
