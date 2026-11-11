import { useEffect, useMemo, useState } from "react";
import type { Navigate } from "../App";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import SourcePicker from "../components/SourcePicker";
import Spinner from "../components/Spinner";
import { formatDuration, parsePlayLines, toVodRef } from "../lib/format";
import type { Episode, PlayLine } from "../lib/format";
import { api, cacheKeys, errorMessage } from "../lib/invoke";
import { pageCache } from "../lib/pageCache";
import { usePageState } from "../lib/usePageState";
import { countEpisodes } from "../lib/sources";
import { prefetchSources } from "../lib/sourceCache";
import type { SourceOption } from "../lib/sources";
import type { HistoryItem, Site, VodInfo } from "../types/tvbox";

interface DetailPageProps {
  siteKey: string;
  vodId: string;
  /** 列表/搜索已知的片名，详情回来之前就能启动后台换源预取。 */
  title?: string;
  siteName?: string;
  sites: Site[];
  navigate: Navigate;
  onBack: () => void;
}

/** 详情页：影片信息 + 收藏 + 线路/剧集选择 + 手动换源。 */
export default function DetailPage({
  siteKey,
  vodId,
  title,
  siteName,
  sites,
  navigate,
  onBack,
}: DetailPageProps) {
  const detailKey = cacheKeys.detail(siteKey, vodId);
  /**
   * 播放页返回时组件会重新挂载：先从数据缓存 / UI 快照直出，命中就完全不发
   * IPC，也不会闪一下 Spinner。线路、筛选词、倒序、简介展开状态一并保留。
   */
  const [vod, setVod] = usePageState<VodInfo | null>(
    `${detailKey}:vod`,
    pageCache.peek<VodInfo[]>(detailKey)?.[0] ?? null,
  );
  const [lineIndex, setLineIndex] = usePageState(`${detailKey}:line`, 0);
  const [episodeQuery, setEpisodeQuery] = usePageState(`${detailKey}:query`, "");
  const [reverse, setReverse] = usePageState(`${detailKey}:reverse`, false);
  const [expanded, setExpanded] = usePageState(`${detailKey}:expanded`, false);

  // 瞬时状态不缓存：刷新序号每次挂载归零，保证回退一定走缓存。
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [favorite, setFavorite] = useState(false);
  const [favBusy, setFavBusy] = useState(false);
  const [favTip, setFavTip] = useState("");
  const [showSources, setShowSources] = useState(false);
  // 历史进度刚在播放页写过，必须每次回到详情重新读，不能缓存成旧值。
  const [resume, setResume] = useState<HistoryItem | null>(null);

  useEffect(() => {
    // reload>0 是用户点了「↻ 刷新」；此时忽略缓存强制拉取最新播放列表。
    if (vod && reload === 0) {
      return;
    }
    let alive = true;
    const run = async () => {
      setLoading(true);
      setError("");
      try {
        const list = await api.detail(siteKey, vodId, reload > 0);
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
    // vod 故意不进依赖：只在挂载 / 换源 / 手动刷新时决定是否请求，
    // 否则渲染过程中写入 vod 会立刻再触发一次 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, vodId, reload]);

  /**
   * 换源候选后台预取：搜索词与片名一致时搜索结果已缓存，这里直接跳过；
   * 从首页 / 收藏进入或搜索词只是片段时，补一次精确片名的全站检索。
   * 整个过程 fire-and-forget，不显示 loading、不影响详情首屏。
   */
  const prefetchTitle = (title?.trim() || vod?.vod_name?.trim() || "").trim();
  useEffect(() => {
    if (!prefetchTitle) {
      return;
    }
    // 详情首屏的 detailContent 先落地，再启动后台全站检索，避免抢首个请求。
    const timer = window.setTimeout(() => prefetchSources(prefetchTitle, sites), 1200);
    return () => window.clearTimeout(timer);
  }, [prefetchTitle, sites]);

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
    navigate(
      { name: "detail", siteKey: option.siteKey, vodId: option.vodId, title: option.vodName },
      true,
    );
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
            title={title || ""}
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
  const cacheAge = pageCache.age(detailKey);
  const cacheLabel =
    cacheAge === undefined
      ? ""
      : cacheAge < 60_000
        ? "刚缓存"
        : `${Math.floor(cacheAge / 60_000)} 分钟前缓存`;

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
          {cacheLabel ? (
            <span className="page-meta" title="播放列表来自本次会话的缓存，点「↻ 刷新」可强制重新拉取">
              {cacheLabel}
            </span>
          ) : null}
        </div>
        <div className="detail-actions">
          <button type="button" className="btn" onClick={() => setShowSources(true)}>
            ⇄ 换源
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setReload((value) => value + 1)}
            disabled={loading}
            title="忽略缓存，重新拉取播放列表"
          >
            ↻ 刷新
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
          title={title || vod.vod_name}
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
