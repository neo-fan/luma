import { useEffect, useState } from "react";
import type { Navigate } from "../App";
import AsyncBoundary from "../components/AsyncBoundary";
import Icon from "../components/Icon";
import PlayButton from "../components/PlayButton";
import VodCard from "../components/VodCard";
import { api, errorMessage } from "../lib/invoke";
import { backfillCovers, mergeMeta } from "../lib/coverBackfill";
import { usePageState } from "../lib/usePageState";
import type { FavoriteItem, VodRef } from "../types/tvbox";

interface FavoritesPageProps {
  navigate: Navigate;
}

/** 收藏页：列表 + 取消收藏。 */
export default function FavoritesPage({ navigate }: FavoritesPageProps) {
  // 收藏是本地 SQLite 读，成本极低：列表先直出，再静默刷新（详情页刚点过
  // 星标时能立刻反映出来），有数据时不再闪 Spinner。
  const [items, setItems] = usePageState<FavoriteItem[]>("favorites:items", []);
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
        const list = await api.favoritesList();
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

  // 从播放页「详情还没到就点收藏」产生的条目没有封面：回查一次详情补上。
  useEffect(() => {
    if (items.length === 0) {
      return;
    }
    let alive = true;
    void backfillCovers(items, "favorites", (patch) => {
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

  const remove = async (item: FavoriteItem) => {
    const key = `${item.siteKey}-${item.vodId}`;
    if (busyKey) {
      return;
    }
    setBusyKey(key);
    setError("");
    const ref: VodRef = {
      siteKey: item.siteKey,
      vodId: item.vodId,
      name: item.name,
      pic: item.pic,
      remarks: item.remarks,
      siteName: item.siteName,
    };
    try {
      await api.favoritesToggle(ref);
      setItems((list) => list.filter((one) => !(one.siteKey === item.siteKey && one.vodId === item.vodId)));
    } catch (err) {
      setError(`取消收藏失败：${errorMessage(err)}`);
    } finally {
      setBusyKey("");
    }
  };

  return (
    <section className="page">
      <header className="page-head">
        <h1 className="page-title">收藏</h1>
        <span className="page-meta">共 {items.length} 条</span>
      </header>

      <AsyncBoundary
        loading={loading}
        error={error}
        isEmpty={items.length === 0}
        loadingLabel="正在加载收藏…"
        emptyTitle="还没有收藏任何影片"
        emptyDescription="在影片详情页点右上角的星标即可加入收藏。"
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
          {items.map((item) => (
            <div className="fav-item" key={`${item.siteKey}-${item.vodId}`}>
              <PlayButton
                label="播放"
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
                sub={item.siteName}
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
                title="取消收藏"
                aria-label="取消收藏"
                disabled={busyKey === `${item.siteKey}-${item.vodId}`}
                onClick={() => void remove(item)}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
      </AsyncBoundary>
    </section>
  );
}
