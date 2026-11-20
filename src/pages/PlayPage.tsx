/**
 * 播放页（`/player`）：侧栏「播放」在没有播放会话时的落地页。
 *
 * 需求（2026-11-15 用户）：「播放路由始终展示吧，取最新历史，空态美化也做一下」。
 * 所以这个入口不再随会话出现/消失：
 * - 有会话时侧栏直接指向会话的播放页（见 AppShell），页面不会走到这里；
 * - 没有会话时落到本页，默认展示**最近一条历史**并一键续播；
 * - 一条历史都没有时给一个像样的空态，而不是把人送回首页。
 *
 * 续播不需要在这里算进度：播放页会按剧名 + 同集去历史里取 `positionMs`
 * （见 `src/pages/PlayerPage.tsx` 的续播 effect），这里只负责把末次
 * `playUrl` / 线路 / 集名原样带过去。
 */
import { useEffect, useState } from "react";
import { PlayCircle } from "lucide-react";
import AsyncBoundary from "../components/AsyncBoundary";
import VodCard from "../components/VodCard";
import Icon from "../components/Icon";
import { useAppStore } from "../stores/appStore";
import { api, errorMessage } from "../lib/invoke";
import { historyCoverMeta, historySubtitle } from "../lib/history";
import { log } from "../lib/logger";
import { usePageState } from "../lib/usePageState";
import type { Navigate } from "../lib/nav";
import type { HistoryItem } from "../types/luma";

interface PlayPageProps {
  navigate: Navigate;
}

/** 已看百分比：拿不到时长时记 0（只画灰底轨）。 */
function watchedPercent(item: HistoryItem): number {
  if (!item.durationMs || item.durationMs <= 0) {
    return 0;
  }
  return Math.min(
    100,
    Math.round(((item.positionMs ?? 0) / item.durationMs) * 100),
  );
}

/**
 * 一条历史能不能直接续播：必须有播放地址。旧版本写入的记录可能只有
 * 详情页信息，那就退回详情页，让详情页重新解析线路。
 */
function canResume(item: HistoryItem): item is HistoryItem & { playUrl: string } {
  return Boolean(item.playUrl && item.playUrl.trim());
}

export default function PlayPage({ navigate }: PlayPageProps) {
  const [items, setItems] = usePageState<HistoryItem[]>("player:history", []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const session = useAppStore((state) => state.playSession);
  const vodSession = session && session.siteKey !== "live" ? session : null;

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
          // 过滤掉 siteKey="live" 的记录：直播没有详情页，这类记录点进去会停在空页。
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
    // 只在挂载 / 手动重试时读库，渲染写入不再回查。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  const shown = items.filter((item) => item.siteKey !== "live");
  const latest = shown[0];
  const rest = shown.slice(1, 13);

  const openDetail = (item: HistoryItem) => {
    navigate({
      name: "detail",
      siteKey: item.siteKey,
      vodId: item.vodId,
      title: item.name,
    });
  };

  const resume = (item: HistoryItem) => {
    if (!canResume(item)) {
      openDetail(item);
      return;
    }
    log.info("resume from play page", {
      siteKey: item.siteKey,
      vodId: item.vodId,
      episode: item.episodeName ?? "",
    });
    navigate({
      name: "player",
      siteKey: item.siteKey,
      vodId: item.vodId,
      vodName: item.name,
      playUrl: item.playUrl,
      episodeName: item.episodeName ?? "",
      playFrom: item.playFrom,
    });
  };

  const backToSession = () => {
    if (!vodSession) {
      return;
    }
    navigate({
      name: "player",
      siteKey: vodSession.siteKey,
      vodId: vodSession.vodId,
      vodName: vodSession.vodName,
      playUrl: vodSession.playUrl,
      episodeName: vodSession.episodeName,
      playFrom: vodSession.playFrom,
      failoverKey: vodSession.failoverKey,
    });
  };

  const watched = latest ? watchedPercent(latest) : 0;

  return (
    <section className="page">
      <header className="page-head">
        <div className="page-head__main">
          <h1 className="page-title">播放</h1>
          <span className="page-meta">
            {shown.length > 0 ? `最近在追 ${shown.length} 部` : "还没有播放记录"}
          </span>
        </div>
      </header>
      <div className="page-body">
        {vodSession ? (
          <div className="resume-live">
            <span className="resume-live__dot" aria-hidden="true" />
            <span className="resume-live__text">
              正在播放《{vodSession.vodName}》{vodSession.episodeName}
            </span>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={backToSession}
            >
              回到播放
            </button>
          </div>
        ) : null}

        <AsyncBoundary
          loading={loading}
          error={error}
          isEmpty={shown.length === 0}
          loadingLabel="正在读取播放记录…"
          emptyTitle="还没有播放记录"
          emptyDescription="在首页或搜索里挑一部片子开播，这里会记住看到哪一集、哪一分钟，下次点开接着看。"
          emptyIcon={PlayCircle}
          onRetry={() => setReload((value) => value + 1)}
          emptyAction={
            <div className="resume-actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => navigate({ name: "home" })}
              >
                去逛逛
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => navigate({ name: "search" })}
              >
                搜索影片
              </button>
            </div>
          }
        >
          {latest ? (
            <article className="resume-hero">
              <div className="resume-hero__poster" aria-hidden="true">
                {latest.pic ? (
                  <img src={latest.pic} alt="" loading="lazy" decoding="async" />
                ) : (
                  <span>{latest.name.trim().slice(0, 1) || "?"}</span>
                )}
              </div>
              <div className="resume-hero__body">
                <p className="resume-hero__eyebrow">上次看到</p>
                <h2 className="resume-hero__title">{latest.name}</h2>
                <p className="resume-hero__meta">
                  {historySubtitle(latest)}
                  {latest.siteName ? ` · ${latest.siteName}` : ""}
                </p>
                <div
                  className="resume-hero__progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={watched}
                  aria-label="上次观看进度"
                >
                  <span style={{ width: `${watched}%` }} />
                </div>
                <div className="resume-hero__actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => resume(latest)}
                  >
                    <Icon name="play" />
                    {watched > 0 ? "继续播放" : "开始播放"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => openDetail(latest)}
                  >
                    查看详情
                  </button>
                </div>
              </div>
            </article>
          ) : null}

          {rest.length > 0 ? (
            <section className="resume-section">
              <h2 className="resume-section__title">最近观看</h2>
              <div className="vod-grid">
                {rest.map((item) => (
                  <VodCard
                    key={`${item.siteKey}-${item.vodId}`}
                    title={item.name}
                    pic={item.pic}
                    remarks={item.remarks}
                    resolution={item.resolution || undefined}
                    coverMeta={historyCoverMeta(item)}
                    hint={historySubtitle(item)}
                    onOpen={() => openDetail(item)}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </AsyncBoundary>
      </div>
    </section>
  );
}
