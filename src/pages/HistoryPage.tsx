import { History } from "lucide-react";
import { useEffect, useState } from "react";
import type { Navigate } from "../lib/nav";
import AsyncBoundary from "../components/AsyncBoundary";
import ConfirmDialog from "../components/ConfirmDialog";
import Icon from "../components/Icon";
import IconButton from "../components/IconButton";
import PlayButton from "../components/PlayButton";
import VodCard from "../components/VodCard";
import { api, errorMessage } from "../lib/invoke";
import { backfillCovers, mergeMeta } from "../lib/coverBackfill";
import { historyCoverMeta, historySubtitle } from "../lib/history";
import { detailTargetFor, vodSeedFromRef } from "../lib/playbackTarget";
import { putDetailSeed } from "../lib/handoff";
import { log } from "../lib/logger";
import { usePageState } from "../lib/usePageState";
import { useAsyncAction } from "../hooks/useAsyncAction";
import type { HistoryItem } from "../types/luma";

interface HistoryPageProps {
  navigate: Navigate;
}

/** 历史页：最近观看的影片 + 进度，点开回到详情页继续播放。 */
export default function HistoryPage({ navigate }: HistoryPageProps) {
  // 与收藏页同一套策略：先直出上次的列表，再静默刷新，有数据时不闪 Spinner。
  const [items, setItems] = usePageState<HistoryItem[]>("history:items", []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { busy: busyKey, run: runAction } = useAsyncAction<string>();
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
          // 过滤掉 siteKey="live" 的记录：直播没有详情页，
          // 这类记录点进 `/detail/live/xxx` 会停在空页。
          setItems(list.filter((item) => item.siteKey !== "live"));
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

  // 历史可能没有封面：按需回查详情补一次。后端不动 updatedAt，补封面不会把这些
  // 记录顶到列表最前。
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
    setError("");
    await runAction(key, async () => {
      await api.historyRemove(item.siteKey, item.vodId);
      setItems((list) =>
        list.filter(
          (one) => !(one.siteKey === item.siteKey && one.vodId === item.vodId),
        ),
      );
      log.info("history removed", { siteKey: item.siteKey, vodId: item.vodId });
    }).catch((err) => {
      setError(`删除历史失败：${errorMessage(err)}`);
    });
  };

  /**
   * 展示用的列表：pageState 里可能还留着上一次会话读到的直播记录
   * （本次过滤只作用于新读的库结果），渲染前再滤一遍。
   */
  const shown = items.filter((item) => item.siteKey !== "live");

  /** 进详情前把这一行的片名/封面交出去，详情页首帧不用等 detailContent。 */
  const openDetail = (item: HistoryItem) => {
    const target = detailTargetFor(item, items);
    putDetailSeed(target.siteKey, vodSeedFromRef(item, target));
    navigate(target);
  };

  const clearAll = () => {
    if (shown.length === 0) {
      return;
    }
    setConfirmClear(true);
  };

  const doClearAll = async () => {
    setConfirmClear(false);
    setError("");
    try {
      await api.historyClear();
      // 后端只删非收藏：列表同步保留收藏行，避免「清空后收藏项也跟着消失」的错觉。
      setItems((list) => list.filter((item) => item.favorite));
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
          <span className="page-meta">共 {shown.length} 条</span>
        </div>
        {shown.length > 0 ? (
          <IconButton
            name="trash"
            label="清空历史"
            tone="danger"
            onClick={clearAll}
          />
        ) : null}
      </header>
      <div className="page-body">
        <AsyncBoundary
          loading={loading}
          error={error}
          isEmpty={shown.length === 0}
          loadingLabel="正在加载观看历史…"
          emptyTitle="还没有观看记录"
          emptyDescription="播放任意影片后，这里会记录进度，方便下次接着看。"
          emptyIcon={History}
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
            {shown.map((item) => {
              const key = `${item.siteKey}-${item.vodId}`;
              // 线路名与集数名来自播放页写入：换过源 / 换过线路后，
              // 用户能一眼看出上次是从哪条线看到第几集 —— 这些压在封面底部，
              // 标题行只留片名（见 historyCoverMeta 的注释）。
              const meta = historyCoverMeta(item);
              // 已看进度（百分比）：拿不到时长时记为 0，按钮只显示灰底轨。
              const watched =
                item.durationMs && item.durationMs > 0
                  ? Math.min(
                      100,
                      Math.round(
                        ((item.positionMs ?? 0) / item.durationMs) * 100,
                      ),
                    )
                  : 0;
              return (
                <div className="fav-item" key={key}>
                  {item.favorite ? (
                    <span
                      className="fav-item__star"
                      title="已收藏"
                      aria-label="已收藏"
                    >
                      <Icon name="star" size={14} />
                    </span>
                  ) : null}
                  <PlayButton
                    percent={watched}
                    label={
                      watched > 0 ? `继续播放（已看 ${watched}%）` : "播放"
                    }
                    onPlay={() => openDetail(item)}
                  />
                  <VodCard
                    title={item.name}
                    pic={item.pic}
                    remarks={item.remarks}
                    resolution={item.resolution || undefined}
                    coverMeta={meta}
                    hint={historySubtitle(item)}
                    doubanTitle={item.name}
                    onOpen={() => openDetail(item)}
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
          message="确定清空观看记录吗？已收藏的剧会保留（含播放进度）。"
          confirmText="清空"
          danger
          onConfirm={() => void doClearAll()}
          onCancel={() => setConfirmClear(false)}
        />
      </div>
    </section>
  );
}
