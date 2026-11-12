import { useEffect, useState } from "react";
import type { Navigate } from "../App";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import Spinner from "../components/Spinner";
import VodCard from "../components/VodCard";
import { api, errorMessage } from "../lib/invoke";
import { backfillCovers, mergeMeta } from "../lib/coverBackfill";
import { historySubtitle } from "../lib/history";
import { log } from "../lib/logger";
import { usePageState } from "../lib/usePageState";
import type { HistoryItem } from "../types/tvbox";

interface HistoryPageProps {
  navigate: Navigate;
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

  // 早先写入的历史没有封面：按需回查详情补一次。后端不动 updatedAt，
  // 补封面不会把这些记录顶到列表最前。
  useEffect(() => {
    if (items.length === 0) {
      return;
    }
    let alive = true;
    void backfillCovers(items, "history", (patch) => {
      if (!alive) {
        return;
      }
      setItems((list) =>
        list.map((one) =>
          one.siteKey === patch.siteKey && one.vodId === patch.vodId
            ? mergeMeta(one, patch)
            : one,
        ),
      );
    });
    return () => {
      alive = false;
    };
    // 只跟条数：回填改写条目时长度不变，不会重跑。
  }, [items.length, setItems]);

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
            // 线路名与集数名来自播放页写入：换过源 / 换过线路后，
            // 用户能一眼看出上次是从哪条线看到第几集。
            const sub = historySubtitle(item);
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
