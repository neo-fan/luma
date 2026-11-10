import { useEffect, useMemo, useState } from "react";
import type { Navigate } from "../App";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import Spinner from "../components/Spinner";
import { parsePlayLines, toVodRef } from "../lib/format";
import { api, errorMessage } from "../lib/invoke";
import type { VodInfo } from "../types/tvbox";

interface DetailPageProps {
  siteKey: string;
  vodId: string;
  siteName?: string;
  navigate: Navigate;
  onBack: () => void;
}

/** 详情页：影片信息 + 收藏 + 线路/剧集选择。 */
export default function DetailPage({ siteKey, vodId, siteName, navigate, onBack }: DetailPageProps) {
  const [vod, setVod] = useState<VodInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  const [favorite, setFavorite] = useState(false);
  const [favBusy, setFavBusy] = useState(false);
  const [favTip, setFavTip] = useState("");

  const [lineIndex, setLineIndex] = useState(0);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      setLoading(true);
      setError("");
      try {
        const list = await api.detail(siteKey, vodId);
        if (!alive) {
          return;
        }
        const first = list && list.length > 0 ? list[0] : null;
        if (!first) {
          setVod(null);
          setError("未获取到影片详情");
          return;
        }
        setVod(first);
        setLineIndex(0);
      } catch (err) {
        if (alive) {
          setVod(null);
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
  }, [siteKey, vodId, reload]);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const list = await api.favoritesList();
        if (alive) {
          setFavorite(list.some((item) => item.siteKey === siteKey && item.vodId === vodId));
        }
      } catch {
        // 收藏状态读不到不影响详情浏览，按钮仍可点击。
        if (alive) {
          setFavorite(false);
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [siteKey, vodId]);

  const lines = useMemo(
    () => parsePlayLines(vod?.vod_play_from, vod?.vod_play_url),
    [vod],
  );
  const line = lines[lineIndex] ?? lines[0] ?? null;

  const toggleFavorite = async () => {
    if (!vod || favBusy) {
      return;
    }
    setFavBusy(true);
    setFavTip("");
    try {
      const next = await api.favoritesToggle(toVodRef(siteKey, siteName, vod));
      setFavorite(next);
      setFavTip(next ? "已加入收藏" : "已取消收藏");
    } catch (err) {
      setFavTip(`收藏操作失败：${errorMessage(err)}`);
    } finally {
      setFavBusy(false);
    }
  };

  if (loading) {
    return (
      <section className="page">
        <Spinner label="正在加载详情…" />
      </section>
    );
  }

  if (error || !vod) {
    return (
      <section className="page">
        <header className="page-head">
          <button type="button" className="btn btn--ghost" onClick={onBack}>
            ← 返回
          </button>
        </header>
        <ErrorBar
          message={`详情加载失败：${error || "影片不存在"}`}
          onRetry={() => setReload((value) => value + 1)}
        />
      </section>
    );
  }

  const chips = [
    vod.vod_year,
    vod.vod_area,
    vod.type_name,
    vod.vod_remarks,
  ].filter((item): item is string => Boolean(item && item.trim()));

  return (
    <section className="page">
      <header className="page-head">
        <div className="page-head__main">
          <button type="button" className="btn btn--ghost" onClick={onBack}>
            ← 返回
          </button>
          <span className="page-meta">{siteName || siteKey}</span>
        </div>
        <button
          type="button"
          className={favorite ? "btn btn--fav is-on" : "btn btn--fav"}
          onClick={() => void toggleFavorite()}
          disabled={favBusy}
          title={favorite ? "取消收藏" : "加入收藏"}
        >
          {favorite ? "★ 已收藏" : "☆ 收藏"}
        </button>
      </header>

      {favTip ? <p className="tip">{favTip}</p> : null}

      <div className="detail-hero">
        <div className="detail-poster">
          {vod.vod_pic ? (
            <img src={vod.vod_pic} alt={vod.vod_name} referrerPolicy="no-referrer" />
          ) : (
            <span className="vod-card__ph">无封面</span>
          )}
        </div>
        <div className="detail-info">
          <h1 className="detail-title">{vod.vod_name || "未命名"}</h1>
          {chips.length > 0 ? (
            <div className="chip-row chip-row--static">
              {chips.map((chip, index) => (
                <span className="chip chip--static" key={`${chip}-${index}`}>
                  {chip}
                </span>
              ))}
            </div>
          ) : null}
          {vod.vod_director ? <p className="detail-line">导演：{vod.vod_director}</p> : null}
          {vod.vod_actor ? <p className="detail-line">主演：{vod.vod_actor}</p> : null}
          <p className="detail-content">{vod.vod_content?.trim() || "暂无简介"}</p>
        </div>
      </div>

      <div className="section">
        <h2 className="section-title">播放线路</h2>
        {lines.length === 0 ? (
          <Empty title="暂无可播放剧集" description="该影片没有提供播放地址。" />
        ) : (
          <>
            <div className="chip-row">
              {lines.map((item, index) => (
                <button
                  key={`${item.name}-${index}`}
                  type="button"
                  className={index === lineIndex ? "chip is-active" : "chip"}
                  onClick={() => setLineIndex(index)}
                >
                  {item.name}
                </button>
              ))}
            </div>

            {line ? (
              <div className="episode-grid">
                {line.episodes.map((episode, index) => (
                  <button
                    key={`${episode.url}-${index}`}
                    type="button"
                    className="episode"
                    onClick={() =>
                      navigate({
                        name: "player",
                        siteKey,
                        vodId,
                        vodName: vod.vod_name,
                        playUrl: episode.url,
                        episodeName: episode.name,
                        playFrom: line.name,
                      })
                    }
                    title={episode.name}
                  >
                    {episode.name}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
