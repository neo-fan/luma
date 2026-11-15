import { Star } from "lucide-react";
import { useEffect, useState } from "react";
import type { Navigate } from "../lib/nav";
import AsyncBoundary from "../components/AsyncBoundary";
import FavStar from "../components/FavStar";
import PlayButton from "../components/PlayButton";
import VodCard from "../components/VodCard";
import { api, errorMessage } from "../lib/invoke";
import { backfillCovers, mergeMeta } from "../lib/coverBackfill";
import { usePageState } from "../lib/usePageState";
import { sameTitle } from "../lib/format";
import { notify } from "../lib/notify";
import type { FavoriteItem, HistoryItem, VodRef } from "../types/luma";

interface FavoritesPageProps {
  navigate: Navigate;
}

/** 收藏页：列表 + 取消收藏。 */
export default function FavoritesPage({ navigate }: FavoritesPageProps) {
  // 收藏是本地 SQLite 读，成本极低：列表先直出，再静默刷新（详情页刚点过
  // 星标时能立刻反映出来），有数据时不再闪 Spinner。
  const [items, setItems] = usePageState<FavoriteItem[]>("favorites:items", []);
  /**
   * `siteKey:vodId → 分辨率`，来自历史记录。
   *
   * 收藏表本身不存分辨率：它只有「想看的」这层语义，而分辨率是「真播出过画」
   * 才拿得到的事实。历史里既然存了，就在这里联查一次，收藏条目才显示角标。
   */
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
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
        const [list, history] = await Promise.all([
          api.favoritesList(),
          // 历史读取失败不影响收藏列表，最多是角标不显示。
          api.historyList().catch(() => [] as HistoryItem[]),
        ]);
        if (alive) {
          setItems(list);
          setResolutions(
            history.reduce<Record<string, string>>((acc, one) => {
              if (one.resolution) {
                acc[`${one.siteKey}:${one.vodId}`] = one.resolution;
              }
              return acc;
            }, {}),
          );
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
      setItems((list) =>
        list.filter(
          (one) =>
            !(
              sameTitle(one.name, item.name) ||
              (one.siteKey === item.siteKey && one.vodId === item.vodId)
            ),
        ),
      );
      notify.info("已取消收藏");
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
      <div className="page-body">
        <AsyncBoundary
          loading={loading}
          error={error}
          isEmpty={items.length === 0}
          loadingLabel="正在加载收藏…"
          emptyTitle="还没有收藏任何影片"
          emptyDescription="在影片详情页点右上角的星标即可加入收藏。"
          emptyIcon={Star}
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
                  resolution={resolutions[`${item.siteKey}:${item.vodId}`]}
                  sub={item.siteName}
                  doubanTitle={item.name}
                  onOpen={() =>
                    navigate({
                      name: "detail",
                      siteKey: item.siteKey,
                      vodId: item.vodId,
                      title: item.name,
                    })
                  }
                />
                {/* 已收藏用实心金星表示，点它即取消——和详情页那颗星是同一套语言，
                  比一个「×」更能说明「这条已经在收藏里」。 */}
                <FavStar
                  on
                  busy={busyKey === `${item.siteKey}-${item.vodId}`}
                  onToggle={() => void remove(item)}
                  className="fav-item__unfav"
                />
              </div>
            ))}
          </div>
        </AsyncBoundary>
      </div>
    </section>
  );
}
