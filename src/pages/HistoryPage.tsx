import { useEffect, useState } from "react";
import type { Navigate } from "../App";
import AsyncBoundary from "../components/AsyncBoundary";
import ConfirmDialog from "../components/ConfirmDialog";
import Icon from "../components/Icon";
import IconButton from "../components/IconButton";
import VodCard from "../components/VodCard";
import { api, errorMessage } from "../lib/invoke";
import { backfillCovers, mergeMeta } from "../lib/coverBackfill";
import { historyCoverMeta, historySubtitle } from "../lib/history";
import { log } from "../lib/logger";
import { usePageState } from "../lib/usePageState";
import type { HistoryItem } from "../types/tvbox";

interface HistoryPageProps {
  navigate: Navigate;
}

/**
 * 历史卡片中央的圆形播放按钮：描边是一圈进度环——灰色底轨表示总时长，
 * 高亮弧表示已看进度（positionMs / durationMs）。点击继续观看，跳到详情页续播。
 * 包裹层与海报同尺寸（aspect-ratio:2/3）且 pointer-events:none，只让按钮本身
 * 可点，不挡卡片其它区域（点海报别处仍走卡片自身的详情跳转）。
 */
function HistoryPlayButton({
  percent,
  label,
  onPlay,
}: {
  percent: number;
  label: string;
  onPlay: () => void;
}) {
  const R = 21;
  const circumference = 2 * Math.PI * R;
  return (
    <div className="fav-play-wrap">
      <button type="button" className="fav-play" title={label} aria-label={label} onClick={onPlay}>
        <svg className="fav-play__ring" viewBox="0 0 48 48" aria-hidden="true">
          <circle className="fav-play__track" cx="24" cy="24" r={R} />
          <circle
            className="fav-play__progress"
            cx="24"
            cy="24"
            r={R}
            style={{ strokeDasharray: `${(circumference * percent) / 100} ${circumference}` }}
          />
        </svg>
        <span className="fav-play__icon">
          <Icon name="play" />
        </span>
      </button>
    </div>
  );
}

/** 历史页：最近观看的影片 + 进度，点开回到详情页继续播放。 */
export default function HistoryPage({ navigate }: HistoryPageProps) {
  // 与收藏页同一套策略：先直出上次的列表，再静默刷新，有数据时不闪 Spinner。
  const [items, setItems] = usePageState<HistoryItem[]>("history:items", []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [reload, setReload] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);

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

  const clearAll = () => {
    if (items.length === 0) {
      return;
    }
    setConfirmClear(true);
  };

  const doClearAll = async () => {
    setConfirmClear(false);
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
          <IconButton
            name="trash"
            label="清空历史"
            tone="danger"
            onClick={clearAll}
          />
        ) : null}
      </header>

      <AsyncBoundary
        loading={loading}
        error={error}
        isEmpty={items.length === 0}
        loadingLabel="正在加载观看历史…"
        emptyTitle="还没有观看记录"
        emptyDescription="播放任意影片后，这里会记录进度，方便下次接着看。"
        onRetry={() => setReload((value) => value + 1)}
        emptyAction={
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => navigate({ name: "home" })}
          >
            去逛逛
          </button>
        }
      >
        <div className="vod-grid">
          {items.map((item) => {
            const key = `${item.siteKey}-${item.vodId}`;
            // 线路名与集数名来自播放页写入：换过源 / 换过线路后，
            // 用户能一眼看出上次是从哪条线看到第几集 —— 这些压在封面底部，
            // 标题行只留片名（见 historyCoverMeta 的注释）。
            const meta = historyCoverMeta(item);
            // 已看进度（百分比）：拿不到时长时记为 0，按钮只显示灰底轨。
            const watched =
              item.durationMs && item.durationMs > 0
                ? Math.min(100, Math.round(((item.positionMs ?? 0) / item.durationMs) * 100))
                : 0;
            return (
              <div className="fav-item" key={key}>
                <HistoryPlayButton
                  percent={watched}
                  label={watched > 0 ? `继续播放（已看 ${watched}%）` : "播放"}
                  onPlay={() =>
                    navigate({
                      name: "detail",
                      siteKey: item.siteKey,
                      vodId: item.vodId,
                      title: item.name,
                    })
                  }
                />
                <VodCard
                  title={item.name}
                  pic={item.pic}
                  remarks={item.remarks}
                  coverMeta={meta}
                  hint={historySubtitle(item)}
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
                  aria-label="删除这条历史"
                  disabled={busyKey === key}
                  onClick={() => void remove(item)}
                >
                  <Icon name="close" />
                </button>
              </div>
            );
          })}
        </div>
      </AsyncBoundary>

      <ConfirmDialog
        open={confirmClear}
        title="清空观看历史"
        message={`确定清空 ${items.length} 条观看历史吗？此操作不可恢复。`}
        confirmText="清空"
        danger
        onConfirm={() => void doClearAll()}
        onCancel={() => setConfirmClear(false)}
      />
    </section>
  );
}
