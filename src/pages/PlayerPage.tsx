import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Navigate } from "../lib/nav";
import SourcePicker from "../components/SourcePicker";
import PlayerHeader from "../components/player/PlayerHeader";
import PlayerStage from "../components/player/PlayerStage";
import PlayerAbout from "../components/player/PlayerAbout";
import EpisodePanel from "../components/player/EpisodePanel";
import PlayerResolution from "../components/player/PlayerResolution";
import { SkipOverlay } from "../components/player/SkipOverlay";
import { SkipSettingsDialog } from "../components/player/SkipSettingsDialog";
import { usePlaybackController } from "../hooks/playback/usePlaybackController";
import { sameTitle, toVodRef } from "../lib/format";
import { EXTERNAL_PLAY_ENABLED } from "../lib/features";
import { resolveEpisodeTarget } from "../lib/episodeResolve";
import { setEpisodePlayCache } from "../lib/episodePlayCache";
import { buildImageUrl, needsProxy, normalizePic } from "../lib/imageUrl";
import { getProxyBaseUrl, resolveProxiedImageSync } from "../hooks/useProxiedImage";
import {
  consumeAutoNav,
  ledgerMarkSite,
  ledgerReset,
} from "../lib/failoverLedger";
import { resolutionBadge, resolutionDetail } from "../lib/resolution";
import type { VideoMeta } from "../lib/resolution";

import { prefetchSources } from "../lib/sourceCache";
import { log } from "../lib/logger";
import { notify } from "../lib/notify";
import { api, errorMessage } from "../lib/invoke";
import { fetchDoubanMeta } from "../lib/douban";
import type { DoubanMeta } from "../lib/douban";
import type { Site, VodInfo } from "../types/luma";
import { usePlayResolution } from "../hooks/usePlayResolution";
import { usePlaybackIndicator } from "../hooks/usePlaybackIndicator";
import { usePlaybackHistory } from "../hooks/usePlaybackHistory";
import { usePlayerEngine, BUILTIN_KINDS } from "../hooks/usePlayerEngine";
import type {
  EpisodeNavControl,
  SkipWindowState,
  UsePlayerEngineHandle,
} from "../hooks/usePlayerEngine";
import {
  formatSkipSummary,
  introMs,
  type SkipKind,
  type SkipSegment,
} from "../lib/skipSegments";
import { useAutoSkipPrompt } from "../hooks/useAutoSkipPrompt";

interface PlayerPageProps {
  siteKey: string;
  vodId: string;
  vodName: string;
  episodeName: string;
  playUrl: string;
  /** TVBox 线路名；有值时先走 playerContent 解析，再交给本地代理。 */
  playFrom?: string;
  /** 站点 `changeable: 0` 时禁止跨站自动换源；缺省允许。手动换源不受限。 */
  allowFailover?: boolean;
  /** 自动换线记账 key：自动跳转时透传；缺省用 vodName（跨站片名可能微变）。 */
  failoverKey?: string;
  /** 手动换源需要站点清单做名称映射与可用性过滤。 */
  sites: Site[];
  siteName?: string;
  /**
   * 当前是否停在播放路由（来自 PlayerHost）。false＝用户在别的页面、本会话
   * 在后台播：此时**自动**换线/换源必须暂停——自愈跳转会把用户当前路由整个
   * 拽回播放页；用户回来时自然会看到结果，届时再由可见的交互继续。
   */
  active?: boolean;
  navigate: Navigate;
  onBack: () => void;
}

/**
 * 播放页：解析地址 → 内置播放 → 记录历史；必要时换源 / 换线路。
 *
 * 重构后「当前播放目标」只有一份真源（`PlaybackController.display`）：
 * `intent ?? committed`。页面不再自己拼 `pendingPick ?? manualPick ??
 * switchedSource ?? 路由` 的优先级链，只做渲染组装。
 */
export default function PlayerPage({
  siteKey,
  vodId,
  vodName,
  episodeName,
  playUrl,
  playFrom,
  allowFailover = true,
  failoverKey,
  sites,
  siteName,
  active = true,
  navigate,
  onBack,
}: PlayerPageProps) {
  /** ArtPlayer 托管原生 <video>；换源、兜底、历史逻辑仍基于它。 */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** 卸载时 ArtPlayer 会清掉 src，进度必须独立留一份快照。 */
  const lastMediaRef = useRef<{ positionMs: number; durationMs?: number }>({
    positionMs: 0,
  });
  /** ArtPlayer 挂载点；实例会在这个容器里生成真正的 <video>。 */
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [videoError, setVideoError] = useState("");
  /**
   * 「还没出画，但源确实在响应」的软提示。
   *
   * 与 `videoError` 严格分开：慢源只该看到中性的加载文案，不该看到红色错误条
   * ——更不该因为它慢就被自动换走（2026-11-14 用户实测：多等十几秒能出画，
   * 却被 12 秒定时器判死跳到别的源）。
   */
  const [slowNotice, setSlowNotice] = useState("");
  const [switchTip, setSwitchTip] = useState("");
  /** 本次挂载是否已从 sessionStorage 恢复过一次性提示。 */
  const tipRestored = useRef(false);
  /**
   * 自动换线记账 key：首轮是片名；自动跳转透传同一 key（跨站片名微变也不失联）。
   * 「试过的地址 / 站点 / 跳转次数」记在模块级 failoverLedger——之前放组件 ref，
   * 而 PlayerPage 每次自动跳转都换 key 重建，ref 清零后 A↔B 站来回横跳无限循环。
   */
  const ledgerKey = failoverKey || vodName.trim();
  const failoverStarted = useRef(false);
  const lineSwitchStarted = useRef(false);
  /**
   * 点播「下一集」控制栏按钮。用 ref 转发：剧集列表异步到达，若把它直接做进
   * 播放内核的 effect 依赖，就会为了一个按钮把正在播的实例整个重建（双声）。
   */
  const episodeNavRef = useRef<EpisodeNavControl | null>(null);
  /** 播放内核句柄：controller 需要它换流，而内核又要 controller 的切换态——用 ref 解环。 */
  const engineRef = useRef<UsePlayerEngineHandle | null>(null);

  const [playerRoot, setPlayerRoot] = useState<HTMLDivElement | null>(null);
  const [videoMeta, setVideoMeta] = useState<VideoMeta>({
    width: 0,
    height: 0,
  });

  const [showSources, setShowSources] = useState(false);
  /** 收藏状态：与详情页共用同一份 SQLite 数据，这里只做镜像。 */
  const [favorite, setFavorite] = useState(false);
  const [favBusy, setFavBusy] = useState(false);

  // 地址解析编排：playUrl → PlayResolved（原地换集/换源不改路由，仍按路由解析）。
  const {
    resolved,
    resolving,
    stage,
    reloading,
    resolveError,
    resolveRetryable,
    reload,
  } = usePlayResolution({
    siteKey,
    playUrl,
    playFrom,
    vodId,
    setSwitchTip,
    setVideoError,
  });

  /** 续播起点：再次打开同一影片时从历史 positionMs 跳过去；刷新重建时由 reloadRef 写入。 */
  const resumeMsRef = useRef(0);
  /** 立即写一次历史：换集 / 换源 / 改倍速后 flush，不等 5 秒节流。 */
  const flushHistoryRef = useRef<(() => void) | null>(null);
  /** 跳过窗口态：驱动「跳过片头/片尾」浮层按钮的显隐。 */
  const [skipState, setSkipState] = useState<SkipWindowState | null>(null);
  const [skipSettingsOpen, setSkipSettingsOpen] = useState(false);
  /** 控制栏「刷新」回调：ref 转发，避免它进播放内核的依赖导致实例重建。 */
  const reloadRef = useRef<(() => void) | null>(null);
  reloadRef.current = () => {
    resumeMsRef.current = Math.round(
      (videoRef.current?.currentTime ?? 0) * 1000,
    );
    setVideoError("");
    reload();
  };

  /**
   * 切换编排（单一播放目标真源 + 意图队列 + 串行提交 + 自愈总线）。
   * 目录拉取、选集、换源、换线全部收敛在这里；页面只消费 display / committed。
   */
  const controller = usePlaybackController({
    siteKey,
    siteName,
    vodId,
    vodName,
    episodeName,
    playUrl,
    playFrom,
    allowFailover,
    ledgerKey,
    navigate,
    engineRef,
    videoRef,
    resolved,
    setSwitchTip,
    setVideoError,
    setShowSources,
    flushHistoryRef,
    resumeMsRef,
    episodeNavRef,
    failoverStarted,
    lineSwitchStarted,
  });

  const {
    display,
    committed,
    lines,
    panelLine,
    setPanelLine,
    switching,
    canPlayNext,
    nextLineBusy,
    switchedUrlRef,
    selectEpisode,
    goEpisode,
    switchSource,
    nextLine,
  } = controller;
  const vod = controller.vod;

  /** 显示真源：乐观意图优先，否则已落地。 */
  const activeSiteKey = display.siteKey;
  const activeSiteName = display.siteName || siteName;
  const activeVodId = display.vodId;
  const activeVodName = display.vodName || vodName;
  const activeLine = display.lines[display.lineIndex] ?? null;
  const activeEpisode = activeLine?.episodes[display.episodeIndex];
  const activeEpisodeName = activeEpisode?.name || episodeName;
  /** 乐观显示是否已领先于已落地（表现「排队中」）。 */
  const pendingPick =
    display !== committed
      ? { lineIndex: display.lineIndex, episodeIndex: display.episodeIndex }
      : null;

  /**
   * 从直播页回到点播：直播播放器创建实例时会硬停「非本容器」的 `<video>`
   * （`lib/playerRegistry` 的全局唯一守卫，用来根治双声），点播这一路要么被
   * 摘掉 src、要么连元素都没了，切回来就是黑屏。这里轮询确认情况：还活着就
   * 不动；被清空就带上进度快照重新解析——用户看到的是「接着播」。
   */
  const lastReviveAt = useRef(0);
  useEffect(() => {
    if (!active || !resolved) {
      return;
    }
    if (Date.now() - lastReviveAt.current < 4000) {
      return;
    }
    let stopped = false;
    let tries = 0;
    let timer = 0;
    const check = () => {
      if (stopped) {
        return;
      }
      const stageEl = containerRef.current;
      const video = stageEl?.querySelector("video") ?? null;
      if (video && (video.getAttribute("src") || video.currentSrc)) {
        stopped = true;
        return;
      }
      const killed = Boolean(video) || tries >= 3;
      if (killed) {
        stopped = true;
        lastReviveAt.current = Date.now();
        resumeMsRef.current =
          lastMediaRef.current.positionMs || resumeMsRef.current;
        reload();
        return;
      }
      tries += 1;
      timer = window.setTimeout(check, 500);
    };
    timer = window.setTimeout(check, 500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [active, resolved, reload]);

  /**
   * 首帧前海报：影片封面过 /image 代理（防盗链 / 内联 header），供播放内核
   * 构造 poster 与舞台解析期背景共用。
   */
  const [posterUrl, setPosterUrl] = useState<string | null>(() =>
    resolveProxiedImageSync(vod?.vod_pic),
  );
  useEffect(() => {
    const value = normalizePic(vod?.vod_pic);
    if (!value) {
      setPosterUrl(null);
      return;
    }
    if (!needsProxy(value)) {
      setPosterUrl(value);
      return;
    }
    let alive = true;
    void getProxyBaseUrl().then((base) => {
      if (alive) {
        setPosterUrl(buildImageUrl(value, base));
      }
    });
    return () => {
      alive = false;
    };
  }, [vod?.vod_pic]);

  /**
   * 历史写入需要「当前线路名 / 当前集名」，用 ref 取值避免把 lines 放进
   * 历史 effect 依赖（那会重建监听并立刻写一次）。
   */
  const historyLabelRef = useRef({ episodeName: "", playFrom: "" });
  historyLabelRef.current = {
    episodeName: activeEpisodeName,
    playFrom: activeLine?.name || playFrom || "",
  };

  /**
   * 豆瓣补全：播放页和详情页同一口径——命中就替掉源站的元数据。
   */
  const [doubanMeta, setDoubanMeta] = useState<DoubanMeta | null>(null);
  useEffect(() => {
    const name = (vod?.vod_name || vodName || "").trim();
    if (!name) {
      setDoubanMeta(null);
      return;
    }
    let alive = true;
    void fetchDoubanMeta(name, vod?.vod_year?.trim() || undefined, {
      priority: true,
      subjectId: vod?.vod_douban_id?.trim() || undefined,
    }).then((meta) => {
      if (alive && meta) {
        setDoubanMeta(meta);
      }
    });
    return () => {
      alive = false;
    };
  }, [vod?.vod_name, vod?.vod_year, vod?.vod_douban_id, vodName]);

  /** 收藏需要完整 vod（封面 / 备注）；详情还没到时用路由参数兜底。 */
  const favVod = useMemo<VodInfo | null>(() => {
    if (vod) {
      return vod;
    }
    if (!vodName.trim()) {
      return null;
    }
    return {
      vod_id: vodId,
      vod_name: vodName,
      vod_pic: "",
      vod_play_from: "",
      vod_play_url: "",
    };
  }, [vod, vodId, vodName]);

  /** 历史要带封面 / 备注 / 站点名，详情晚到时由节流写入补上。 */
  const historyMetaRef = useRef({ pic: "", remarks: "", siteName: "" });
  historyMetaRef.current = {
    pic: vod?.vod_pic?.trim() || "",
    remarks: vod?.vod_remarks?.trim() || "",
    siteName: activeSiteName || "",
  };

  // 历史数据层（续播/倍速/片头片尾记忆 + 5 秒节流写回）。
  const {
    readRememberedRate,
    readRememberedSkip,
    rememberedRateRef,
    rememberedSkipRef,
    skipConfig,
    setSkipConfig,
    skipEnabled,
    setSkipEnabled,
  } = usePlaybackHistory({
    siteKey,
    vodId,
    vodName,
    episodeName,
    playUrl,
    ledgerKey,
    videoRef,
    resolved,
    activeSiteKey,
    activeVodId,
    activeVodName,
    resumeMsRef,
    lastMediaRef,
    historyMetaRef,
    historyLabelRef,
    flushHistoryRef,
    attachSignal: playerRoot,
  });

  /**
   * 详情没到就点了收藏 → 当时只能存空封面。等详情到达后补一次元数据。
   */
  const favNeedsCover = useRef(false);
  useEffect(() => {
    if (!favNeedsCover.current || !favorite || !vod?.vod_pic?.trim()) {
      return;
    }
    favNeedsCover.current = false;
    void api.favoritesPatchMeta(toVodRef(activeSiteKey, activeSiteName, vod)).catch(() => {
      // 补封面失败不影响收藏本身。
    });
  }, [favorite, vod, activeSiteKey, activeSiteName]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await api.favoritesList();
        if (alive) {
          setFavorite(
            list.some(
              (item) =>
                sameTitle(item.name, vod?.vod_name || vodName) ||
                (item.siteKey === activeSiteKey && item.vodId === activeVodId),
            ),
          );
        }
      } catch {
        if (alive) {
          setFavorite(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeSiteKey, activeVodId]);

  const toggleFavorite = async () => {
    if (!favVod || favBusy) {
      return;
    }
    setFavBusy(true);
    try {
      const favRef = toVodRef(activeSiteKey, activeSiteName, favVod);
      const next = await api.favoritesToggle(favRef);
      setFavorite(next);
      favNeedsCover.current = next && !favRef.pic;
      if (next) {
        notify.success("已加入收藏");
      } else {
        notify.info("已取消收藏");
      }
    } catch (err) {
      notify.error("收藏失败，请重试");
      log.warn("favorite toggle failed", { message: errorMessage(err) });
    } finally {
      setFavBusy(false);
    }
  };

  const playable = resolved !== null && BUILTIN_KINDS.includes(resolved.kind);

  /**
   * 与详情页共用的换源候选缓存：播放页多是从详情跳转过来，缓存已就绪；
   * 从历史/收藏直接播放时这里补一次精确片名的后台检索。
   */
  useEffect(() => {
    if (!vodName.trim()) {
      return;
    }
    const timer = window.setTimeout(
      () => prefetchSources(vodName, sites),
      5000,
    );
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vodName, siteKey, sites.length]);

  const ledgerInited = useRef(false);
  useEffect(() => {
    if (!ledgerInited.current) {
      ledgerInited.current = true;
      if (!consumeAutoNav()) {
        ledgerReset(ledgerKey);
      }
      ledgerMarkSite(ledgerKey, siteKey);
    }
    failoverStarted.current = false;
    lineSwitchStarted.current = false;
    const carried = window.sessionStorage.getItem("luma:autoSwitch");
    if (carried) {
      window.sessionStorage.removeItem("luma:autoSwitch");
      setSwitchTip(carried);
      tipRestored.current = true;
    } else if (!tipRestored.current) {
      setSwitchTip("");
    }
  }, [siteKey, playUrl]);

  // 取不到流 / 解析失败时不再自动换线或换源：只留错误条与手动按钮。
  // 切换一律由用户点选发起（乐观切换，不预先探活）。

  /**
   * 播放内核：ArtPlayer + hls.js / mpegts.js + 偏好记忆 + stalled watchdog。
   * 必须先于 history / ended 两个 effect（它们直接读内核写入的 videoRef.current）。
   */
  const engine = usePlayerEngine({
    containerRef,
    videoRef,
    lastMediaRef,
    failoverStarted,
    lineSwitchStarted,
    episodeNavRef,
    canNext: canPlayNext,
    switching,
    reloadRef,
    resumeMsRef,
    rememberedRate: readRememberedRate,
    onRememberedRate: (rate) => {
      rememberedRateRef.current = rate;
      flushHistoryRef.current?.();
    },
    rememberedSkip: readRememberedSkip,
    onSkipState: setSkipState,
    onOpenSkipSettings: () => setSkipSettingsOpen(true),
    resolved,
    resolving,
    siteKey,
    vodName,
    vodId,
    poster: posterUrl ?? undefined,
    onVideoMeta: setVideoMeta,
    onPlayerRoot: setPlayerRoot,
    onSlowNotice: (text) => setSlowNotice(text ?? ""),
    setVideoError,
  });
  engineRef.current = engine;

  // 常驻层切页不卸载播放器：播放状态进全局 store，侧栏图标才能亮小圆点。
  usePlaybackIndicator(videoRef, "vod", resolved);

  // 换集 / 换源后旧分辨率不属于新画面：先清空，等新一集 loadedmetadata 再上报。
  useEffect(() => {
    setVideoMeta({ width: 0, height: 0 });
  }, [resolved]);

  /**
   * 接下一集：自然播完（ended）与「跳过片尾」共用同一条路径。返回 false 表示
   * 没有下一集（最后一集或线路数据未就绪），调用方自行决定停在哪。
   *
   * 提示只走播放器内的 notice：换流本来就发生在画面里，页面级 toast 在这里
   * 是重复噪声（用户看到的是画面切走 + 顶部弹一条，两处同时动）。
   */
  const advanceToNext = useCallback(() => {
    if (!canPlayNext || !activeLine) {
      return false;
    }
    const next = activeLine.episodes[display.episodeIndex + 1];
    log.info("auto next episode", {
      siteKey,
      vodId,
      from: display.episodeIndex,
      to: display.episodeIndex + 1,
    });
    engine.notice(`正在播放下一集${next ? `：${next.name}` : ""}`);
    goEpisode(1);
    return true;
  }, [activeLine, canPlayNext, display.episodeIndex, engine, goEpisode, siteKey, vodId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const onEnded = () => {
      advanceToNext();
    };
    video.addEventListener("ended", onEnded);
    return () => video.removeEventListener("ended", onEnded);
  }, [resolved, advanceToNext]);

  const playExternal = async () => {
    if (!EXTERNAL_PLAY_ENABLED) {
      return;
    }
    const target = switchedUrlRef.current || resolved?.url || playUrl;
    try {
      await api.openExternal(target);
    } catch (err) {
      setVideoError(`打开外部播放器失败：${errorMessage(err)}`);
    }
  };

  /**
   * 下一集预解析：当前集稳定出画后延迟 5s，后台把下一集解析好写进按集缓存。
   */
  const preResolveRef = useRef<{ timer: number | null; busy: boolean; gen: number }>({
    timer: null,
    busy: false,
    gen: 0,
  });
  const preResolveTargetRef = useRef<{
    siteKey: string;
    playFrom: string;
    url: string;
  } | null>(null);
  const nextEpisodeForPreResolve =
    canPlayNext && activeLine ? activeLine.episodes[display.episodeIndex + 1] : null;
  preResolveTargetRef.current =
    nextEpisodeForPreResolve?.url && activeLine
      ? {
          siteKey: activeSiteKey,
          playFrom: activeLine.name,
          url: nextEpisodeForPreResolve.url,
        }
      : null;
  const preResolveGuardRef = useRef({ resolving: true, switching: false });
  preResolveGuardRef.current = { resolving, switching: switchTip !== "" };

  const runPreResolve = useCallback(async () => {
    const state = preResolveRef.current;
    const target = preResolveTargetRef.current;
    const video = videoRef.current;
    if (
      state.busy ||
      !target ||
      !video ||
      video.paused ||
      video.ended ||
      preResolveGuardRef.current.resolving ||
      preResolveGuardRef.current.switching
    ) {
      return;
    }
    state.busy = true;
    const gen = state.gen;
    try {
      const next = await resolveEpisodeTarget(target.siteKey, target.playFrom, target.url);
      if (next.unresolvable) {
        return;
      }
      const play = await api.resolvePlay({
        siteKey: target.siteKey,
        url: next.url,
        ua: next.ua,
        referer: next.referer,
        cookie: next.cookie,
      });
      const now = preResolveTargetRef.current;
      if (
        gen === state.gen &&
        now &&
        now.siteKey === target.siteKey &&
        now.playFrom === target.playFrom &&
        now.url === target.url
      ) {
        setEpisodePlayCache(target.siteKey, target.playFrom, target.url, play);
        log.info("next episode pre-resolved", {
          siteKey: target.siteKey,
          kind: play.kind,
        });
      }
    } catch {
      // 预解析失败不影响任何现有链路：用户真点下一集时会重新解析。
    } finally {
      state.busy = false;
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const state = preResolveRef.current;
    if (!video || siteKey === "live") {
      return;
    }
    const cancel = () => {
      if (state.timer !== null) {
        window.clearTimeout(state.timer);
        state.timer = null;
      }
    };
    const arm = () => {
      cancel();
      state.timer = window.setTimeout(() => {
        state.timer = null;
        void runPreResolve();
      }, 5000);
    };
    const onPlaying = () => {
      if (!video.paused) {
        arm();
      }
    };
    const onPause = () => cancel();
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    return () => {
      cancel();
      state.gen += 1;
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, siteKey, runPreResolve]);

  useEffect(() => {
    const text = switchTip || slowNotice;
    if (!text) {
      return;
    }
    engine.notice(text);
    if (!switchTip) {
      return;
    }
    const timer = window.setInterval(() => engine.notice(text), 1500);
    return () => window.clearInterval(timer);
  }, [engine, switchTip, slowNotice]);

  /** 当前集名：剧集列表到达后用列表里的名字，否则用路由参数。 */
  const nowEpisode = activeEpisode?.name || episodeName;

  /**
   * 选集区只关心「目录有没有拿到」：换源/换集的线路数据在 intent 落地前就已经
   * 写进 `display.lines`，再罩一层 loading 等于二次加载（用户已经能看到剧集）。
   * 只有首次从历史/收藏进入、目录尚未回来时才遮。
   */
  const panelBusy = switching && lines.length === 0;

  /** 片头/片尾配置改动统一入口：写 ref + 镜像 state + 齿轮行 tooltip + 即时落库。 */
  const applySkipConfig = (segs: SkipSegment[]) => {
    rememberedSkipRef.current = segs;
    setSkipConfig(segs);
    engine.setSkipSettingTooltip(formatSkipSummary(segs, skipEnabled));
    flushHistoryRef.current?.();
  };
  /** 这部剧的「跳过」开关：只切是否发起跳转，已配好的时长原样留着。 */
  const applySkipEnabled = (next: boolean) => {
    setSkipEnabled(next);
    engine.setSkipSettingTooltip(formatSkipSummary(skipConfig, next));
    flushHistoryRef.current?.();
  };
  /** 自定义弹窗「取当前播放时间」读实时播放头 / 时长。 */
  const getPlayhead = () => {
    const v = videoRef.current;
    if (!v) {
      return null;
    }
    return {
      currentMs: (v.currentTime || 0) * 1000,
      durationMs: Number.isFinite(v.duration) ? v.duration * 1000 : Number.NaN,
    };
  };
  // 齿轮行 tooltip 跟随当前配置与开关（历史载入 / 弹窗改动都覆盖到）。
  useEffect(() => {
    engine.setSkipSettingTooltip(formatSkipSummary(skipConfig, skipEnabled));
  }, [skipConfig, skipEnabled, engine]);

  // 自动跳过：进入片头/片尾窗口先给 3 秒可取消倒计时，到点才真正 seek。边沿判定与
  // 倒计时在 `useAutoSkipPrompt`；这里只给「执行跳转」的动作 + 媒体身份（换集/换源复位）。
  const doSkipIntro = () => {
    const v = videoRef.current;
    const intro = introMs(skipConfig);
    if (v && intro > 0) {
      try {
        v.currentTime = intro / 1000;
      } catch {
        /* seek 未就绪时忽略 */
      }
    }
  };
  const doSkipOutro = () => {
    // 有下一集就直接接：以前是 seek 到 duration-0.5 等 ended，流末尾不触发
    // ended（或视频刚好暂停）时会停在最后一帧，表现成「跳过片尾就暂停」。
    if (advanceToNext()) {
      return;
    }
    // 没有可接的下一集：保持当前画面，不 seek 到结尾制造一次暂停。
    engine.notice("没有可接的下一集");
  };
  const autoSkipMediaKey = [activeSiteKey, display.vodId, display.lineIndex, display.episodeIndex].join(":");
  const { pending: autoSkipPending, cancel: cancelAutoSkip } = useAutoSkipPrompt(
    // 这部剧关掉跳过：窗口态一律不给（倒计时/自动跳都挂在它上面，源头断掉即可，
    // 不必在内核与弹窗里各判一次开关）。
    skipEnabled ? skipState : null,
    autoSkipMediaKey,
    (kind: SkipKind) => (kind === "intro" ? doSkipIntro() : doSkipOutro()),
    () => videoRef.current?.paused ?? false,
    // 倒计时只在「这一集真的出画」后显示：换集后窗口态在 loadedmetadata 就到，
    // 那时画面还是上一集的静止帧，倒计时会看着像在跳上一集。
    () => {
      const v = videoRef.current;
      return Boolean(v && !v.paused && v.readyState >= 3);
    },
  );
  // 切换在途 → ArtPlayer 原生 loading；收口即隐藏。
  useEffect(() => {
    engine.setLoading(switching || engine.switching);
  }, [switching, engine]);

  // 「下一集」按钮：详情未到时 lines 为空，按钮先以禁用态存在。
  episodeNavRef.current = {
    canNext: canPlayNext,
    onNext: () => goEpisode(1),
    switching,
  };

  /* 播放舞台：画面 + 分辨率角标（角标是 portal，渲染进 ArtPlayer 根节点）。 */
  const stageNode = (
    <>
      <PlayerStage
        resolving={resolving}
        stage={stage}
        reloading={reloading}
        switching={switching || engine.switching}
        playable={playable}
        recovering={false}
        pending={resolved === null}
        resolveError={switchedUrlRef.current ? "" : resolveError}
        playbackError={videoError}
        retryable={resolveRetryable}
        containerRef={containerRef}
        poster={posterUrl ?? undefined}
        onNextLine={nextLine}
        nextLineBusy={nextLineBusy}
      />
      <PlayerResolution
        host={playerRoot}
        label={resolutionBadge(videoMeta)}
        detail={resolutionDetail(videoMeta.width, videoMeta.height)}
        episode={activeEpisodeName}
        bitrate={videoMeta.bitrateKbps}
      />
      <SkipOverlay
        host={playerRoot}
        pending={autoSkipPending}
        onCancelAuto={cancelAutoSkip}
      />
      <SkipSettingsDialog
        host={playerRoot}
        open={skipSettingsOpen}
        config={skipConfig}
        enabled={skipEnabled}
        onEnabledChange={applySkipEnabled}
        getPlayhead={getPlayhead}
        onConfigChange={applySkipConfig}
        onClose={() => setSkipSettingsOpen(false)}
      />
    </>
  );

  return (
    <section className="page page--player">
      <PlayerHeader
        vodName={activeVodName}
        episodeName={activeEpisodeName}
        onBack={onBack}
        favorite={favorite}
        favBusy={favBusy}
        onToggleFavorite={() => void toggleFavorite()}
      />

      <div className="page-body">
        {/* 播放/解析错误统一在播放器画面里展示（PlayerStage），页面顶部不再挂红条。 */}
        {stageNode}
        <PlayerAbout
          vod={vod}
          fallbackName={activeVodName}
          siteKey={activeSiteKey}
          siteName={activeSiteName}
          lineName={activeLine?.name}
          episodeLabel={nowEpisode || undefined}
          douban={doubanMeta}
          onPlayExternal={
            EXTERNAL_PLAY_ENABLED ? () => void playExternal() : undefined
          }
        />

        {lines.length > 0 ? (
          <EpisodePanel
            lines={lines}
            panelLine={panelLine}
            lineIndex={display.lineIndex}
            episodeIndex={display.episodeIndex}
            pendingPick={pendingPick}
            loading={panelBusy}
            setPanelLine={setPanelLine}
            goToEpisode={selectEpisode}
            onSwitchSource={() => setShowSources(true)}
          />
        ) : null}

        {showSources ? (
          <SourcePicker
            title={activeVodName}
            currentSiteKey={activeSiteKey}
            currentSiteName={activeSiteName}
            sites={sites}
            notice={
              allowFailover
                ? undefined
                : "当前源禁止自动换源，手动切换仍由你决定。"
            }
            onPick={switchSource}
            onClose={() => setShowSources(false)}
          />
        ) : null}
      </div>
    </section>
  );
}
