import { useEffect, useMemo, useState } from "react";
import type { Navigate } from "../App";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import SourcePicker from "../components/SourcePicker";
import Spinner from "../components/Spinner";
import { formatDuration, parsePlayLines, toVodRef } from "../lib/format";
import type { Episode, PlayLine } from "../lib/format";
import { api, errorMessage } from "../lib/invoke";
import { countEpisodes } from "../lib/sources";
import type { SourceOption } from "../lib/sources";
import type { HistoryItem, Site, VodInfo } from "../types/tvbox";

interface DetailPageProps {
  siteKey: string;
  vodId: string;
  siteName?: string;
  sites: Site[];
  navigate: Navigate;
  onBack: () => void;
}

/** 详情页：影片信息 + 收藏 + 线路/剧集选择 + 手动换源。 */
export default function DetailPage({
  siteKey,
  vodId,
  siteName,
  sites,
  navigate,
  onBack,
}: DetailPageProps) {
  const [vod, setVod] = useState<VodInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  const [favorite, setFavorite] = useState(false);
  const [favBusy, setFavBusy] = useState(false);
  const [favTip, setFavTip] = useState("");

  const [lineIndex, setLineIndex] = useState(0);
  const [episodeQuery, setEpisodeQuery] = useState("");
  const [reverse, setReverse] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [resume, setResume] = useState<HistoryItem | null>(null);

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

  // 收藏与观看进度都是「看一眼就走」的旁路数据，失败不阻断详情浏览。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await api.favoritesList();
        if (alive) {
          setFavorite(list.some((item) => item.siteKey === siteKey && item.vodId === vodId));
        }
      } catch {
        if (alive) {
          setFavorite(false);
        }
      }
      try {
        const history = await api.historyList();
        if (alive) {
          setResume(
            history.find((item) => item.siteKey === siteKey && item.vodId === vodId) ?? null,
          );
        }
      } catch {
        if (alive) {
          setResume(null);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [siteKey, vodId]);

  const lines = useMemo(
    () => parsePlayLines(vod?.vod_play_from, vod?.vod_play_url),
    [vod],
  );
  const line = lines[lineIndex] ?? lines[0] ?? null;

  /** 集数多时（动辄上百集）提供名称/序号过滤与倒序，index 保留原序号。 */
  const episodes = useMemo(() => {
    const list = (line?.episodes ?? []).map((episode, index) => ({ episode, index }));
    const word = episodeQuery.trim().toLowerCase();
    const filtered = word
      ? list.filter(
          ({ episode, index }) =>
            episode.name.toLowerCase().includes(word) || String(index + 1) === word,
        )
      : list;
    return reverse ? filtered.slice().reverse() : filtered;
  }, [line, episodeQuery, reverse]);

  /** 「继续播放」优先回到历史里的那一集，否则从第一集开始。 */
  const quickPlay = useMemo(() => {
    if (resume) {
      for (const item of lines) {
        const index = item.episodes.findIndex((episode) => episode.url === resume.playUrl);
        if (index >= 0) {
          return { line: item, episode: item.episodes[index], index };
        }
      }
    }
    const first = lines[0];
    return first?.episodes.length
      ? { line: first, episode: first.episodes[0], index: 0 }
      : null;
  }, [lines, resume]);

  const playEpisode = (target: PlayLine, episode: Episode) => {
    navigate({
      name: "player",
      siteKey,
      vodId,
      vodName: vod?.vod_name ?? "",
      playUrl: episode.url,
      episodeName: episode.name,
      playFrom: target.name,
    });
  };

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

  /** 换源只替换当前详情页，避免返回键在几十个源之间来回绕。 */
  const pickSource = (option: SourceOption) => {
    setShowSources(false);
    navigate({ name: "detail", siteKey: option.siteKey, vodId: option.vodId }, true);
  };

  if (loading) {
    return (
      <section className="page">
        <header className="page-head">
          <div className="page-head__main">
            <button type="button" className="btn btn--ghost" onClick={onBack}>
              ← 返回
            </button>
            {/* 换源瞬间就能看到新源名，不必等详情请求回来。 */}
            <span className="detail-source" title={siteKey}>
              当前源：{siteName || siteKey}
            </span>
          </div>
        </header>
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
          <button type="button" className="btn" onClick={() => setShowSources(true)}>
            ⇄ 换源
          </button>
        </header>
        <ErrorBar
          message={`详情加载失败：${error || "影片不存在"}`}
          onRetry={() => setReload((value) => value + 1)}
        />
        {showSources ? (
          <SourcePicker
            title=""
            currentSiteKey={siteKey}
            currentSiteName={siteName}
            sites={sites}
            onPick={pickSource}
            onClose={() => setShowSources(false)}
          />
        ) : null}
      </section>
    );
  }

  const chips = [
    vod.vod_year,
    vod.vod_area,
    vod.type_name,
    vod.vod_remarks,
  ].filter((item): item is string => Boolean(item && item.trim()));
  const site = sites.find((item) => item.key === siteKey);
  const description = vod.vod_content?.trim() || "暂无简介";

  return (
    <section className="page">
      <header className="page-head">
        <div className="page-head__main">
          <button type="button" className="btn btn--ghost" onClick={onBack}>
            ← 返回
          </button>
          <span className="detail-source" title={siteKey}>
            当前源：{siteName || siteKey}
          </span>
        </div>
        <div className="detail-actions">
          <button type="button" className="btn" onClick={() => setShowSources(true)}>
            ⇄ 换源
          </button>
          <button
            type="button"
            className={favorite ? "btn btn--fav is-on" : "btn btn--fav"}
            onClick={() => void toggleFavorite()}
            disabled={favBusy}
            title={favorite ? "取消收藏" : "加入收藏"}
          >
            {favorite ? "★ 已收藏" : "☆ 收藏"}
          </button>
        </div>
      </header>

      {favTip ? <p className="tip">{favTip}</p> : null}
      {site?.changeable === false ? (
        <p className="tip">该源声明 changeable=0，已关闭自动换源；手动换源仍可使用。</p>
      ) : null}

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
          <p className={expanded ? "detail-content" : "detail-content is-clamped"}>
            {description}
          </p>
          <div className="detail-actions detail-actions--inline">
            {description.length > 120 ? (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? "收起简介" : "展开简介"}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--primary"
              disabled={!quickPlay}
              onClick={() => quickPlay && playEpisode(quickPlay.line, quickPlay.episode)}
            >
              {resume && quickPlay
                ? `▶ 继续播放 第 ${quickPlay.index + 1} 集（${formatDuration(resume.positionMs ?? 0)}）`
                : "▶ 播放第 1 集"}
            </button>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h2 className="section-title">播放线路</h2>
          <span className="page-meta">
            共 {lines.length} 条线路 · {countEpisodes(lines)} 集
          </span>
        </div>
        {lines.length === 0 ? (
          <Empty title="暂无可播放剧集" description="该影片没有提供播放地址，可试试手动换源。" />
        ) : (
          <>
            <div className="chip-row">
              {lines.map((item, index) => (
                <button
                  key={`${item.name}-${index}`}
                  type="button"
                  className={index === lineIndex ? "chip is-active" : "chip"}
                  onClick={() => setLineIndex(index)}
                  title={`${item.episodes.length} 集`}
                >
                  {item.name}（{item.episodes.length}）
                </button>
              ))}
            </div>

            <div className="detail-episode-tools">
              <input
                className="input"
                type="text"
                value={episodeQuery}
                placeholder="筛选剧集名称 / 集号"
                aria-label="筛选剧集"
                onChange={(event) => setEpisodeQuery(event.target.value)}
              />
              <button type="button" className="btn" onClick={() => setReverse((value) => !value)}>
                {reverse ? "正序" : "倒序"}
              </button>
              <span className="page-meta">显示 {episodes.length} 集</span>
            </div>

            {line ? (
              <div className="episode-grid">
                {episodes.map(({ episode, index }) => (
                  <button
                    key={`${episode.url}-${index}`}
                    type="button"
                    className={
                      resume?.playUrl === episode.url ? "episode is-seen" : "episode"
                    }
                    onClick={() => playEpisode(line, episode)}
                    title={episode.name}
                  >
                    {episode.name}
                    {resume?.playUrl === episode.url ? (
                      <span className="episode__flag">上次看到</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
            {episodes.length === 0 ? (
              <Empty title="没有匹配的剧集" description="换个名称或集号再试。" />
            ) : null}
          </>
        )}
      </div>

      {showSources ? (
        <SourcePicker
          title={vod.vod_name}
          currentSiteKey={siteKey}
          currentSiteName={siteName}
          sites={sites}
          notice={site?.changeable === false ? "当前源禁止自动换源，手动切换仍由你决定。" : undefined}
          onPick={pickSource}
          onClose={() => setShowSources(false)}
        />
      ) : null}
    </section>
  );
}
