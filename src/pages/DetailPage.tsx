import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Navigate } from "../App";
import { useProxiedImage } from "../hooks/useProxiedImage";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import FavStar from "../components/FavStar";
import Icon from "../components/Icon";
import IconButton from "../components/IconButton";
import SourcePicker from "../components/SourcePicker";
import Spinner from "../components/Spinner";
import { formatDuration, parsePlayLines, plainText, toVodRef } from "../lib/format";
import type { Episode, PlayLine } from "../lib/format";
import { findPlayableSource } from "../lib/crossSourceRecovery";
import { api, cacheKeys, errorMessage } from "../lib/invoke";
import { pageCache } from "../lib/pageCache";
import { noDetailSources } from "../lib/noDetailSource";
import { usePageState } from "../lib/usePageState";
import { countEpisodes } from "../lib/sources";
import { prefetchSources } from "../lib/sourceCache";
import { log } from "../lib/logger";
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

/**
 * 「自动切到的目标页」不再做跨源自愈：目标页的详情已经探活过，万一再次读空
 * （缓存失效 / 源偶发），不该又跳到第三个源，形成连环跳转。
 */
const skipCrossSource = new Set<string>();
/** 跨源成功后的一次性提示（模块级变量够用，不必写 sessionStorage）。 */
let pendingRecoveryNotice: string | null = null;

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
  // TVBox `vod_pic` may carry inline @headers; route the hero image through
  // the same local /image proxy the cards use.
  const heroImage = useProxiedImage(vod?.vod_pic);
  const [lineIndex, setLineIndex] = usePageState(`${detailKey}:line`, 0);
  const [episodeQuery, setEpisodeQuery] = usePageState(`${detailKey}:query`, "");
  const [reverse, setReverse] = usePageState(`${detailKey}:reverse`, false);
  const [expanded, setExpanded] = usePageState(`${detailKey}:expanded`, false);

  /**
   * 「展开简介」按钮是否出现，按 clamp 后的真实溢出高度决定，而不是字符数硬阈值：
   * 简介可能 >120 字却没被裁切（点了无变化），也可能 <120 字就被 84px 裁掉
   * （按钮不出现却看不到全文）。这里把元素临时切回 clamp 量 scrollHeight，
   * 超出 clientHeight 才认为「真的被截断」，按钮才出现。
   */
  const contentRef = useRef<HTMLParagraphElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  const measureDescription = useCallback(() => {
    const el = contentRef.current;
    if (!el) {
      setOverflowing(false);
      return;
    }
    // 临时回到 clamp 状态测量真实溢出，测完恢复当下展开/收起态，不闪烁。
    const wasExpanded = el.classList.contains("is-expanded");
    el.classList.remove("is-expanded");
    el.classList.add("is-clamped");
    const isOver = el.scrollHeight > el.clientHeight + 1;
    el.classList.remove("is-clamped");
    if (wasExpanded) {
      el.classList.add("is-expanded");
    }
    setOverflowing(isOver);
  }, []);

  useLayoutEffect(() => {
    measureDescription();
  }, [vod?.vod_content, expanded, siteKey, vodId, measureDescription]);

  useEffect(() => {
    window.addEventListener("resize", measureDescription);
    return () => window.removeEventListener("resize", measureDescription);
  }, [measureDescription]);

  // 瞬时状态不缓存：刷新序号每次挂载归零，保证回退一定走缓存。
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /**
   * 「当前源没给这部片详情」与「请求真的失败」要分开：
   * 前者（列表为空）在 TVBox 生态里很常见——发现/榜单型源本来就只给海报，
   * 不是客户端故障，不该画红色错误条；后者（抛异常）才按失败处理。
   */
  const [empty, setEmpty] = useState(false);
  const [reload, setReload] = useState(0);
  const [favorite, setFavorite] = useState(false);
  const [favBusy, setFavBusy] = useState(false);
  const [favTip, setFavTip] = useState("");
  const [showSources, setShowSources] = useState(false);
  // 空详情（发现/推荐型源）时自动按片名去其它源找可播放版本的状态。
  const [fallback, setFallback] = useState<"idle" | "searching" | "none">("idle");
  const fallbackCancelRef = useRef(false);
  const [recoveryNotice] = useState(() => pendingRecoveryNotice);
  // dev StrictMode 会把 useState 初始化器跑两次：不能在初始化器里清空，否则
  // 第二次挂载读到 null、提示直接消失。改到 effect 里清（幂等，跑两次无碍）。
  useEffect(() => {
    if (recoveryNotice) {
      pendingRecoveryNotice = null;
    }
  }, [recoveryNotice]);
  // 历史进度刚在播放页写过，必须每次回到详情重新读，不能缓存成旧值。
  const [resume, setResume] = useState<HistoryItem | null>(null);

  useEffect(() => {
    // reload>0 是用户点了刷新图标；此时忽略缓存强制拉取最新播放列表。
    if (vod && reload === 0) {
      return;
    }
    let alive = true;
    const run = async () => {
      setLoading(true);
      setError("");
      setEmpty(false);
      setFallback("idle");
      fallbackCancelRef.current = false;
      try {
        // 列表/搜索已给出的片名用于空详情自愈：旧 vod_id 失效时按名回查。
        const list = await api.detail(siteKey, vodId, reload > 0, (title || "").trim());
        if (!alive) {
          return;
        }
        const first = list && list.length > 0 ? list[0] : null;
        if (!first) {
          setVod(null);
          // 不算异常：只是这个源没给播放列表（发现/榜单型源就是这样）。
          // 文案与后续动作分开处理，红色错误条只留给真正的请求失败。
          setEmpty(true);
          // 发现型源（豆瓣[py] 等）连 searchContent 都没有，同站按名回查必然
          // 失败。改用片名在其它站点里找一个真能播的详情，成功就直接切过去；
          // 用户一旦手动操作（重试 / 打开换源面板）就中止，避免迟到结果跳页。
          const word = (title || "").trim();
          if (!word || skipCrossSource.has(`${siteKey}:${vodId}`)) {
            return;
          }
          setFallback("searching");
          void (async () => {
            try {
              const result = await findPlayableSource(word, sites, siteKey, () =>
                alive && !fallbackCancelRef.current,
              );
              if (!alive || fallbackCancelRef.current) {
                return;
              }
              if (!result.found) {
                setFallback("none");
                log.warn("cross-source recovery found no playable candidate", {
                  siteKey,
                  vodId,
                  title: word,
                  probed: result.probed,
                });
                return;
              }
              const found = result.found;
              skipCrossSource.add(`${found.siteKey}:${found.vodId}`);
              pendingRecoveryNotice =
                `《${word}》在当前源没有播放列表，已切换到「${found.siteName || found.siteKey}」`;
              log.info("detail recovered from another source", {
                from: siteKey,
                to: found.siteKey,
                vodId: found.vodId,
                probed: result.probed,
              });
              navigate(
                { name: "detail", siteKey: found.siteKey, vodId: found.vodId, title: found.vodName },
                true,
              );
            } catch (err) {
              if (alive) {
                setFallback("none");
                log.warn("cross-source recovery failed", {
                  siteKey,
                  vodId,
                  message: errorMessage(err),
                });
              }
            }
          })();
          return;
        }
        setVod(first);
        setFallback("idle");
        setEmpty(false);
        setLineIndex(0);
      } catch (err) {
        if (alive) {
          setVod(null);
          setError(errorMessage(err));
          log.warn("detail failed", {
            siteKey,
            vodId,
            message: errorMessage(err),
          });
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
      // 首选上次那条线路：同一部剧的线路顺序可能变，按名字定位更稳。
      const preferred = resume.playFrom
        ? lines.find((item) => item.name === resume.playFrom)
        : undefined;
      const order = preferred
        ? [preferred, ...lines.filter((item) => item !== preferred)]
        : lines;
      for (const item of order) {
        const index = item.episodes.findIndex((episode) => episode.url === resume.playUrl);
        if (index >= 0) {
          return { line: item, episode: item.episodes[index], index };
        }
      }
      // 源的剧集地址换了（CDN 轮换很常见）：回到同线路、同名的那一集。
      if (preferred && resume.episodeName) {
        const index = preferred.episodes.findIndex(
          (episode) => episode.name === resume.episodeName,
        );
        if (index >= 0) {
          return { line: preferred, episode: preferred.episodes[index], index };
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
    fallbackCancelRef.current = true;
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
            <IconButton name="back" label="返回" onClick={onBack} />
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
    const retry = () => {
      fallbackCancelRef.current = true;
      // 手动重试意味着用户不接受「这个源没详情」，把记忆清掉重新判定。
      noDetailSources.forget(siteKey);
      setReload((value) => value + 1);
    };
    const openSources = () => {
      fallbackCancelRef.current = true;
      setShowSources(true);
    };
    // 这个源已被证实「详情空 + 按名也搜不到」（含本次请求刚判定的）：直接
    // 说明它是榜单/推荐源，不让用户以为是客户端坏了。
    const known = !error && empty && noDetailSources.has(siteKey);
    return (
      <section className="page">
        <header className="page-head">
          <IconButton name="back" label="返回" onClick={onBack} />
          <IconButton name="swap" label="换源" onClick={openSources} />
        </header>
        {error ? (
          <ErrorBar message={`详情加载失败：${error}`} onRetry={retry} />
        ) : (
          <div className="detail-empty" role="status">
            <p className="detail-empty__title">
              {known
                ? `「${siteName || siteKey}」不提供播放列表`
                : title
                  ? `《${title}》在当前源没有播放列表`
                  : "当前源没有返回影片详情"}
            </p>
            <p className="detail-empty__desc">
              {known
                ? "这类源只提供榜单/推荐（海报、评分、片名），点任何影片都不会有剧集，换片也一样。"
                : "可能是影片 id 失效或站点临时波动，也可能是这个源只做发现/推荐。"}
              {fallback === "searching"
                ? `正在按片名从其它源查找${title ? `《${title}》` : ""}的可播放版本，找到后会自动切换…`
                : fallback === "none"
                  ? "已按片名在其它源查找，暂时没有找到可播放的版本。"
                  : ""}
            </p>
            <div className="detail-empty__actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={retry}>
                重试
              </button>
              <button type="button" className="btn btn--primary btn--sm" onClick={openSources}>
                换源
              </button>
            </div>
          </div>
        )}
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
  const description = plainText(vod.vod_content) || "暂无简介";
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
          <IconButton name="back" label="返回" onClick={onBack} />
          <span className="detail-source" title={siteKey}>
            当前源：{siteName || siteKey}
          </span>
          {cacheLabel ? (
            <span className="page-meta" title="播放列表来自本次会话的缓存，点刷新可强制重新拉取">
              {cacheLabel}
            </span>
          ) : null}
        </div>
        <div className="iconbar">
          <IconButton name="swap" label="换源" onClick={() => setShowSources(true)} />
          <IconButton
            name="refresh"
            label="刷新"
            busy={loading}
            onClick={() => setReload((value) => value + 1)}
            disabled={loading}
          />
        </div>
      </header>

      {recoveryNotice ? <p className="tip tip--ok">{recoveryNotice}</p> : null}
      {favTip ? <p className="tip">{favTip}</p> : null}
      {site?.changeable === false ? (
        <p className="tip">该源声明 changeable=0（不建议作为换源目标）；按片名跨源查找仍会进行，手动换源也可用。</p>
      ) : null}

      <div className="detail-hero">
        <div className="detail-poster">
          {heroImage.src && !heroImage.broken ? (
            <img src={heroImage.src} alt={vod.vod_name} referrerPolicy="no-referrer" onError={heroImage.onError} />
          ) : (
            <span className="vod-card__ph">{vod.vod_pic ? "无封面" : ""}</span>
          )}
        </div>
        <div className="detail-info">
          <div className="detail-title-row">
            <h1 className="detail-title">{vod.vod_name || "未命名"}</h1>
            <FavStar on={favorite} busy={favBusy} onToggle={() => void toggleFavorite()} />
          </div>
          {chips.length > 0 ? (
            <div className="chip-row chip-row--static">
              {chips.map((chip, index) => (
                <span className="chip chip--static" key={`${chip}-${index}`}>
                  {chip}
                </span>
              ))}
            </div>
          ) : null}
          {vod.vod_director ? (
            <p className="detail-line">导演：{plainText(vod.vod_director)}</p>
          ) : null}
          {vod.vod_actor ? (
            <p className="detail-line">主演：{plainText(vod.vod_actor)}</p>
          ) : null}
          <p
            ref={contentRef}
            className={expanded ? "detail-content is-expanded" : "detail-content is-clamped"}
          >
            {description}
          </p>
          <div className="detail-actions detail-actions--inline">
            {overflowing || expanded ? (
              <IconButton
                name="chevron"
                label={expanded ? "收起简介" : "展开简介"}
                expanded={expanded}
                className="icon-btn--rotate"
                onClick={() => setExpanded((value) => !value)}
              />
            ) : null}
            {/* 按钮只留动作本身：线路有 chip 的「上次」角标、集数有剧集格的「上次看到」，
                进度这类细节放 hover 提示里，不占按钮文案。 */}
            <button
              type="button"
              className="btn btn--primary"
              disabled={!quickPlay}
              onClick={() => quickPlay && playEpisode(quickPlay.line, quickPlay.episode)}
              title={
                resume && quickPlay
                  ? `上次看到：${resume.episodeName || `第 ${quickPlay.index + 1} 集`} · ${formatDuration(resume.positionMs ?? 0)}`
                  : undefined
              }
            >
              <Icon name="play" />
              {resume && quickPlay ? "继续播放" : "播放第 1 集"}
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
                  title={
                    resume?.playFrom === item.name
                      ? `${item.episodes.length} 集 · 上次观看的线路`
                      : `${item.episodes.length} 集`
                  }
                >
                  {item.name}（{item.episodes.length}）
                  {resume?.playFrom === item.name ? (
                    <span className="chip__flag">上次</span>
                  ) : null}
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
              <IconButton
                name="sort"
                label={reverse ? "正序" : "倒序"}
                pressed={reverse}
                className="icon-btn--flip"
                onClick={() => setReverse((value) => !value)}
              />
              <span className="page-meta">显示 {episodes.length} 集</span>
            </div>

            {line ? (
              <div className="episode-grid">
                {episodes.map(({ episode, index }) => {
                  // 地址可能被源换过 CDN，地址匹配不上时用「同线路 + 同集名」兜底。
                  const seen = resume
                    ? resume.playUrl === episode.url ||
                      (!!resume.episodeName &&
                        resume.playFrom === line.name &&
                        resume.episodeName === episode.name)
                    : false;
                  return (
                    <button
                      key={`${episode.url}-${index}`}
                      type="button"
                      className={seen ? "episode is-seen" : "episode"}
                      onClick={() => playEpisode(line, episode)}
                      title={episode.name}
                    >
                      {episode.name}
                      {seen ? <span className="episode__flag">上次看到</span> : null}
                    </button>
                  );
                })}
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
