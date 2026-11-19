import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Navigate } from "../lib/nav";
import ErrorBar from "../components/ErrorBar";
import SourcePicker from "../components/SourcePicker";
import PlayerHeader from "../components/player/PlayerHeader";
import PlayerStage from "../components/player/PlayerStage";
import PlayerAbout from "../components/player/PlayerAbout";
import EpisodePanel from "../components/player/EpisodePanel";
import PlayerResolution from "../components/player/PlayerResolution";
import { SkipOverlay } from "../components/player/SkipOverlay";
import { SkipSettingsDialog } from "../components/player/SkipSettingsDialog";
import { usePlaybackSwitchCore, usePlaybackSwitch } from "../hooks/usePlaybackSwitchCore";
import { sameTitle, toVodRef } from "../lib/format";
import type { PlayLine } from "../lib/format";
import { EXTERNAL_PLAY_ENABLED } from "../lib/features";
import { resolveEpisodeTarget } from "../lib/episodeResolve";
import { setEpisodePlayCache } from "../lib/episodePlayCache";
import { buildImageUrl, needsProxy, normalizePic } from "../lib/imageUrl";
import { getProxyBaseUrl, resolveProxiedImageSync } from "../hooks/useProxiedImage";
import {
  consumeAutoNav,
  ledgerHasUrl,
  ledgerMarkSite,
  ledgerMarkUrl,
  ledgerReset,
} from "../lib/failoverLedger";
import {
  resolutionBadge,
  resolutionDetail,
} from "../lib/resolution";
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
import { useEpisodeList } from "../hooks/useEpisodeList";
import { usePlayerEngine, BUILTIN_KINDS } from "../hooks/usePlayerEngine";
import type { EpisodeNavControl } from "../hooks/usePlayerEngine";
import type { SkipWindowState } from "../hooks/usePlayerEngine";
import {
  formatSkipSummary,
  introMs,
  type SkipSegment,
} from "../lib/skipSegments";

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

/** 播放页：解析地址 → 内置播放 → 记录历史；必要时换源 / 换线路。 */

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
  /** 已经自动处理过的地址，避免切线路 / 换源之间来回跳转。 */
  /**
   * 同一轮播放只允许一次「找下一条线路」；后到的失败信号**等**这一次的结果。
   * `lineSwitchStarted` 是给播放内核看的「有切换在进行」闸门（它只认布尔），
   * `lineAttempt` 负责去重并把同一次结论返回给所有并发调用方。
   */
  const lineSwitchStarted = useRef(false);
  const lineAttempt = useRef<Promise<boolean> | null>(null);
  /**
   * 点播「下一集」控制栏按钮。用 ref 转发：剧集列表异步到达，若把它直接做进
   * 播放内核的 effect 依赖，就会为了一个按钮把正在播的实例整个重建（双声）。
   * 赋值放在 goEpisode 定义之后、render 期间完成，effect 执行时已是最新值。
   */
  const episodeNavRef = useRef<EpisodeNavControl | null>(null);
  /**
   * 自动自愈总线的转发句柄：engine 参数要用它，而自愈结论要等 engine 之后的
   * 编排 hook 才算得出来 —— 页面先建 ref、编排 hook 每渲染赋值，解这个环。
   */
  const switchOrFailoverRef = useRef<() => Promise<void>>(async () => {});

  /**
   * 分辨率角标：数据只能从播放内核里的 `<video>` 读到（解码后的真实尺寸），
   * 由内核通过 `onVideoMeta` 上报；`playerRoot` 是 ArtPlayer 的模板根节点，
   * 也是全屏请求的对象，角标 portal 进它才能在满屏时仍然可见。
   */
  const [playerRoot, setPlayerRoot] = useState<HTMLDivElement | null>(null);
  const [videoMeta, setVideoMeta] = useState<VideoMeta>({
    width: 0,
    height: 0,
  });

  /**
   * 自动换线路过程中为 true：这段时间画面上的红色错误条先不渲。
   *
   * 换线路是「有希望自愈」的过程，用户看到「播放失败」再看着它自己消失，
   * 比直接等他三秒更让人怀疑。切换以 navigate 结束（新页面 recovering 归零），
   * 若线路全灭则复位，让错误重新出现。
   */
  const [recovering, setRecovering] = useState(false);
  const [showSources, setShowSources] = useState(false);
  /**
   * 原地换集时覆盖「当前线路/集」：路由里的 playUrl 仍指向进入本页时那一集，
   * 但播放器已经换到新地址；显示、历史标签、下一集按钮都以这里为准。
   */
  const [manualPick, setManualPick] = useState<{
    lineIndex: number;
    episodeIndex: number;
  } | null>(null);
  // 切换并发核心（代次令牌 / 串行提交门 / 切换锁 / 合并队列 / 兜底 effect）：
  // 搬至 hooks/usePlaybackSwitchCore；编排层（usePlaybackSwitch）消费同一批句柄。
  const switchCore = usePlaybackSwitchCore({ episodeNavRef, videoRef, playUrl, setSwitchTip });
  const { pendingPick, episodeSwitching } = switchCore;
  /**
   * 原地换源：跨站切换后路由身份（siteKey/vodId/vodName）还是进入本页时那一份，
   * 但播放器已经在放新源。显示、历史、收藏都以这份覆盖值为准，免得「换源后
   * 历史记到旧站」或信息卡写着旧站名。
   */
  const [switchedSource, setSwitchedSource] = useState<{
    siteKey: string;
    siteName: string;
    vodId: string;
    vodName: string;
    lines: PlayLine[];
    lineIndex: number;
    episodeIndex: number;
  } | null>(null);
  /** 收藏状态：与详情页共用同一份 SQLite 数据，这里只做镜像。 */
  const [favorite, setFavorite] = useState(false);
  const [favBusy, setFavBusy] = useState(false);

  // 地址解析编排：playUrl → PlayResolved（effect 体与依赖数组原样保留在 hook 内）。
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

  /**
   * 续播起点：再次打开同一影片时从历史 positionMs 跳过去；刷新重建时由
   * reloadRef 写入当前进度。消费一次即清零（见 usePlayerEngine.applyResume）。
   */
  const resumeMsRef = useRef(0);
  /** 原地换集后的真实播放地址（路由里的 playUrl 不跟着改）。 */
  /** 跳过窗口态：驱动「跳过片头/片尾」浮层按钮的显隐。 */
  const [skipState, setSkipState] = useState<SkipWindowState | null>(null);
  /** 自定义「片头/片尾」配置弹窗开关（入口在 ArtPlayer 原生齿轮那一行）。 */
  const [skipSettingsOpen, setSkipSettingsOpen] = useState(false);

  /** 控制栏「刷新」回调：ref 转发，避免它进播放内核的依赖导致实例重建。 */
  const reloadRef = useRef<(() => void) | null>(null);
  reloadRef.current = () => {
    // 重新解析会重建实例；把当前进度留给新实例，刷新后不回到片头。
    resumeMsRef.current = Math.round(
      (videoRef.current?.currentTime ?? 0) * 1000,
    );
    setVideoError("");
    reload();
  };

  /**
   * 从直播页回到点播：直播播放器创建实例时会硬停「非本容器」的 `<video>`
   * （`lib/playerRegistry` 的全局唯一守卫，用来根治双声），点播这一路要么被
   * 摘掉 src、要么连元素都没了，切回来就是黑屏。这里轮询确认情况：还活着就
   * 不动；被清空就带上进度快照重新解析——用户看到的是「接着播」。
   *
   * 不能只在挂载后检查一次：`resolved` 比 video 元素先到，一次判定会把
   * 「还没建出来」误当成「被杀了」；反过来元素被摘掉后才来不及救。
   */
  /** 上一次自动恢复的时间：reload 会让 `resolved` 换新对象，避免连环重试。 */
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
      const stage = containerRef.current;
      const video = stage?.querySelector("video") ?? null;
      // 正常在播（有自己的源）：什么都不做。
      if (video && (video.getAttribute("src") || video.currentSrc)) {
        stopped = true;
        return;
      }
      // 元素还在但没有源 = 被直播层硬停过；元素都没了 = 实例已被清掉。
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

  // 剧集列表编排：拉详情 + 按 playUrl 定位 line/episode（effect 体原样保留在 hook 内）。
  const {
    lines,
    lineIndex,
    episodeIndex,
    panelLine,
    setPanelLine,
    currentLine,
    vod,
  } = useEpisodeList(siteKey, vodId, playUrl, episodeName, playFrom);

  const activeSiteKey = switchedSource?.siteKey ?? siteKey;
  const activeSiteName = switchedSource?.siteName ?? siteName;
  const activeVodId = switchedSource?.vodId ?? vodId;
  const activeVodName = switchedSource?.vodName || vodName;
  const activeLines = switchedSource?.lines ?? lines;
  // 「正在播/选中」的显示真源：先认点击即设的乐观意图 pendingPick（点一下立刻
  // 移动标题与高亮，不等后台解析），其次已成功落地的 manualPick，再跨源覆盖值，
  // 最后路由。过期异步绝不再把这些写回旧集（见 fallback 不再 null manualPick）。
  const activeLineIndex =
    pendingPick?.lineIndex ?? manualPick?.lineIndex ?? switchedSource?.lineIndex ?? lineIndex;
  const activeEpisodeIndex =
    pendingPick?.episodeIndex ?? manualPick?.episodeIndex ?? switchedSource?.episodeIndex ?? episodeIndex;
  const activeLine = activeLines[activeLineIndex] ?? currentLine;
  const activeEpisode = activeLine?.episodes[activeEpisodeIndex];
  const activeEpisodeName = activeEpisode?.name || episodeName;
  // 「实时已落地」基线：只认成功后的 manualPick / 跨源覆盖值 / 路由，不含乐观
  // pendingPick。相对导航（下一集、看完自动接）以它为准 —— 连点时目标恒等于
  // committed+1、被去重忽略 → 净 +1、绝不跳多集；最后一集越界即停。显示走乐观，
  // 导航走实时，正是「播放控制 / 相对跳」与「后台换流」解耦的落点。
  const committedLineIndex = manualPick?.lineIndex ?? switchedSource?.lineIndex ?? lineIndex;
  const committedEpisodeIndex =
    manualPick?.episodeIndex ?? switchedSource?.episodeIndex ?? episodeIndex;
  const committedLine = activeLines[committedLineIndex] ?? activeLine;
  const canPlayNext = Boolean(
    committedLine && committedEpisodeIndex + 1 < committedLine.episodes.length,
  );

  /**
   * 首帧前海报：影片封面过 /image 代理（防盗链 / 内联 header），供播放内核
   * 构造 poster 与舞台解析期背景共用。URL 构造是 lib/imageUrl 的纯函数，
   * 代理端口复用 useProxiedImage 导出的 getProxyBaseUrl（非 hook 的进程级
   * 单例，不在引擎里引 React hook）。封面缺失 / 代理不可用时退化为直连或
   * 无海报，绝不阻塞播放。
   */
  const [posterUrl, setPosterUrl] = useState<string | null>(() =>
    // 首帧同步解析：详情有 数据缓存 种子、代理端口有进程级缓存时，remount
    // 第一个 commit 就有海报（缓存命中路径实例建得极快，异步海报赶不上）。
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
   * 历史写入需要「当前线路名 / 当前集名」，但两个值随异步剧集列表到达才确定。
   * 用 ref 取值，避免把 lines 放进历史 effect 依赖（那会重建监听并立刻写一次）。
   * 自动换线路 / 自动换源时 navigate 没有带 playFrom，currentLine.name 才可靠。
   */
  const historyLabelRef = useRef({ episodeName: "", playFrom: "" });
  historyLabelRef.current = {
    episodeName: activeEpisodeName,
    playFrom: activeLine?.name || playFrom || "",
  };

  /**
   * 豆瓣补全：播放页和详情页同一口径——命中就替掉源站的元数据，源站只负责
   * 播放线路与兜底。片名/年份到位后问一次；`fetchDoubanMeta` 自带去重与缓存，
   * 从详情页进来时基本是命中缓存，不会再打豆瓣。
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
      // 用户已经在看这一部了：别让首页推荐卡的预取排在前面。
      priority: true,
      // 源自带豆瓣 subject id 时按 id 直取，跳过搜索那一跳。
      subjectId: vod?.vod_douban_id?.trim() || undefined,
    }).then(
      (meta) => {
        if (alive && meta) {
          setDoubanMeta(meta);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [vod?.vod_name, vod?.vod_year, vod?.vod_douban_id, vodName]);

  /** 收藏需要完整 vod（封面 / 备注）；详情还没到时用路由参数兜底，先收藏不误事。 */
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

  /**
   * 历史要带封面 / 备注 / 站点名。详情与播放进度是两条并行链路，详情常晚于
   * 第一次写入到达；用 ref 取最新值，后续 5 秒节流的写入会把元数据补上，
   * 且 DB 侧空值不覆盖已有封面。
   */
  const historyMetaRef = useRef({ pic: "", remarks: "", siteName: "" });
  historyMetaRef.current = {
    pic: vod?.vod_pic?.trim() || "",
    remarks: vod?.vod_remarks?.trim() || "",
    siteName: activeSiteName || "",
  };
  // 历史数据层（续播/倍速/片头片尾记忆 + 5 秒节流写回）：搬至 usePlaybackHistory。
  const {
    readRememberedRate,
    readRememberedSkip,
    rememberedRateRef,
    rememberedSkipRef,
    flushHistoryRef,
    skipConfig,
    setSkipConfig,
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
  });

  /**
   * 详情没到就点了收藏 → 当时只能存空封面。等详情到达后补一次元数据，
   * 只补一次，不动收藏时间。
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
          // 收藏按片名记录：自动换源后 siteKey/vodId 都变了，星标仍要认得同一部片。
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
      // 加收藏时详情还没到（没有封面）：等详情回来补，别让收藏列表留空图。
      favNeedsCover.current = next && !favRef.pic;
      if (next) {
        notify.success("已加入收藏");
      } else {
        notify.info("已取消收藏");
      }
    } catch (err) {
      // 收藏失败不是播放错误，别再往画面里插红色 error bar。
      notify.error("收藏失败，请重试");
      log.warn("favorite toggle failed", { message: errorMessage(err) });
    } finally {
      setFavBusy(false);
    }
  };

  const playable = resolved !== null && BUILTIN_KINDS.includes(resolved.kind);

  /**
   * 媒体是否已经真的出过画（或正在播）。
   *
   * 这是「不能自动换源」的最硬证据：解码器拿到过帧、时间轴走过，说明这条
   * 线路是活的；此时路由里 `playUrl` 的解析结论（失败 / kind=page）已经
   * 过期——原地换集或换源后它根本不是正在播的地址。
   */
  const mediaHasStarted = () => {
    const video = videoRef.current;
    if (!video) {
      return false;
    }
    return video.currentTime > 0 || (!video.paused && video.readyState >= 2);
  };

  /**
   * 与详情页共用的换源候选缓存：播放页多是从详情跳转过来，缓存已就绪；
   * 从历史/收藏直接播放时这里补一次精确片名的后台检索，点换源图标不等待。
   */
  useEffect(() => {
    if (!vodName.trim()) {
      return;
    }
    // 首帧解析优先：播放起来后再补换源候选，避免与 resolve_play 争用 sidecar。
    const timer = window.setTimeout(
      () => prefetchSources(vodName, sites),
      5000,
    );
    return () => window.clearTimeout(timer);
    // sites 由 App 以稳定引用传入；length 覆盖「配置还在异步加载」时从历史
    // / 收藏直接进播放页的情况，站点到达后再补一次预取判定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vodName, siteKey, sites.length]);

  const ledgerInited = useRef(false);
  useEffect(() => {
    // StrictMode 会把挂载 effect 连跑两次：只有第一次允许消费 autoNav 标记，
    // 否则第二次会误判成「手动点播」把账清掉。
    if (!ledgerInited.current) {
      ledgerInited.current = true;
      if (!consumeAutoNav()) {
        // 用户手动点播：新的一轮，清掉该片名的旧账。
        ledgerReset(ledgerKey);
      }
      ledgerMarkSite(ledgerKey, siteKey);
    }
    failoverStarted.current = false;
    lineSwitchStarted.current = false;
    lineAttempt.current = null;
    // 换源/换集跳转会重建本页，提示通过 sessionStorage 带过来一次。
    // dev 的 React.StrictMode 会把挂载 effect 连跑两次：第一次读走并删掉
    // 提示，第二次就会读到 null。若此时无条件清空，用户永远看不到提示，
    // 所以用 ref 记住「本次挂载已恢复过」，第二次不再覆盖。
    const carried = window.sessionStorage.getItem("luma:autoSwitch");
    if (carried) {
      window.sessionStorage.removeItem("luma:autoSwitch");
      setSwitchTip(carried);
      tipRestored.current = true;
    } else if (!tipRestored.current) {
      setSwitchTip("");
    }
  }, [siteKey, playUrl]);

  /**
   * 自动换源：当前源取不到流时，用片名在全部站点里搜同名条目，逐个探测，
   * 只有真正返回 200 的流才切过去（避免把一个死源换成另一个死源）。
   */
  /**
   * 探一条候选线路能不能播：playerContent → resolve_play → 真拉一次媒体。
   *
   * 失败一律当作 `false`（抛异常也吃掉）：探活只是「猜哪条线能播」，
   * 不该把异常抛给切线路流程。
   */

  useEffect(() => {
    // 原地换集/换源之后，路由里的 playUrl 已经不代表正在播的地址：
    // 它的解析结论（失败、kind=page）都是上一轮的，不能再拿它去换源。
    // 暂停中不自动换任何东西：用户按暂停就是「先停在这儿」，此时路由里的
    // 旧 playUrl 解析失败（换集/换源后它是过期地址）不代表当前线路坏了。
    if (
      !active ||
      switchedUrlRef.current ||
      videoRef.current?.paused ||
      mediaHasStarted()
    ) {
      return;
    }
    if (
      resolving ||
      resolveError ||
      !resolved ||
      resolved.kind !== "page"
    ) {
      return;
    }
    if (ledgerHasUrl(ledgerKey, playUrl)) {
      return;
    }
    void switchOrFailoverRef.current();
  }, [active, resolved, resolving, resolveError, playUrl, ledgerKey]);

  /**
   * 解析失败也要自动换线路。
   *
   * 之前只有「解析成分享页（kind=page）」才触发换源，像 `CO4K_…` / `qsvip-…`
   * 这种网盘 token 线路会直接在画面上留一块「无法解析播放地址」——用户要么
   * 自己回去点别的线路，要么放弃。面板里明明有 PAN1 能播，就该自动切过去。
   *
   * 试过的地址记在 failoverLedger（模块级，跨重挂载存活），避免「换线路 →
   * 又回到同一条」的循环；跳转次数有上限，预算用完就停下报错交还用户。
   */
  useEffect(() => {
    // 同上：已经原地换到新地址时，旧地址的「解析失败」不该把画面切走；
    // 暂停中也不换 —— 用户只是停下来，不代表这条线路坏了。
    if (
      !active ||
      switchedUrlRef.current ||
      videoRef.current?.paused ||
      mediaHasStarted() ||
      resolving ||
      !resolveError
    ) {
      return;
    }
    if (ledgerHasUrl(ledgerKey, playUrl)) {
      return;
    }
    // 「源还没答完」（冷启动 / 忙时超预算）不是线路坏了：保留这条线路，
    // 让用户点刷新重试。用户实测过再等十几秒就能出画，自动换走反而丢掉它。
    if (resolveRetryable) {
      return;
    }
    ledgerMarkUrl(ledgerKey, playUrl);
    setRecovering(true);
    setSwitchTip("当前线路无法解析，正在尝试其它线路…");
    void switchOrFailoverRef.current().finally(() => setRecovering(false));
  }, [active, resolving, resolveError, resolveRetryable, playUrl, ledgerKey]);

  /**
   * 播放内核：ArtPlayer + hls.js / mpegts.js + 偏好记忆 + stalled watchdog。
   * effect 体逐字保留在 usePlayerEngine，声明顺序须先于 history
   * 与 ended 两个 effect（它们直接读内核写入的 videoRef.current）。
   */
  /**
   * 换集/换源提示与「源侧慢」都塞进播放器 notice 层：提示贴着画面、全屏也可见，
   * 页面顶部不再挂一条与播放器分离的文案。
   */
  const engine = usePlayerEngine({
    containerRef,
    videoRef,
    lastMediaRef,
    failoverStarted,
    lineSwitchStarted,
    switchOrFailoverRef,
    episodeNavRef,
    canNext: canPlayNext,
    switching: episodeSwitching,
    reloadRef,
    resumeMsRef,
    rememberedRate: readRememberedRate,
    onRememberedRate: (rate) => {
      rememberedRateRef.current = rate;
      // 倍速是低频动作，改完立刻写一次：只靠 5 秒节流会让「调完就关窗」丢掉。
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
  // 切换编排（选集/换源/换线/自愈总线）：搬至 usePlaybackSwitch，
  // 派生值经 depsRef 注入，回调身份稳定、读到的永远是最新渲染。
  const {
    switchedUrlRef,
    nextLineBusy,
    goToEpisode,
    goEpisode,
    pickSource,
    pickNextLine,
  } = usePlaybackSwitch({
    ...switchCore,
    navigate,
    resolved,
    siteKey,
    vodId,
    vodName,
    episodeName,
    playUrl,
    allowFailover,
    ledgerKey,
    engine,
    activeSiteKey,
    activeVodId,
    activeVodName,
    activeLines,
    activeEpisodeIndex,
    activeEpisodeName,
    committedLine,
    committedLineIndex,
    committedEpisodeIndex,
    lines,
    setSwitchTip,
    setVideoError,
    setSwitchedSource,
    setManualPick,
    setShowSources,
    flushHistoryRef,
    resumeMsRef,
    failoverStarted,
    lineSwitchStarted,
    lineAttempt,
    switchOrFailoverRef,
    videoRef,
  });

  // 常驻层切页不卸载播放器：播放状态进全局 store，侧栏图标才能亮小圆点。
  usePlaybackIndicator(videoRef, "vod", resolved);

  // 换集 / 换源后旧分辨率不属于新画面：先清空，等新一集 `loadedmetadata`
  // 再上报，避免切集瞬间角标还挂着上一集的 1080P。
  useEffect(() => {
    setVideoMeta({ width: 0, height: 0 });
  }, [resolved]);


  /**
   * 看完一集自动接下一集：连看时不必每集回来点按钮。
   *
   * `ended` 只在当前 <video> 上生效，而换集会重建播放内核，所以依赖里带上
   * `resolved`；直播与最后一集不接。
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const onEnded = () => {
      if (!canPlayNext || !activeLine) {
        return;
      }
      const next = activeLine.episodes[activeEpisodeIndex + 1];
      log.info("auto next episode", {
        siteKey,
        vodId,
        from: activeEpisodeIndex,
        to: activeEpisodeIndex + 1,
      });
      // 自动换台的完成确认：原地切换改版把旧的页面内提示弄丢了，用户只能靠
      // 「画面突然变了」意识到换了集。低打扰 toast 补回这条反馈。
      notify.info(`已自动播放下一集${next ? `：${next.name}` : ""}`);
      goToEpisode(activeLineIndex, activeEpisodeIndex + 1);
    };
    video.addEventListener("ended", onEnded);
    return () => video.removeEventListener("ended", onEnded);
    // navigate / lines 随集数变化，但真正需要重挂的只有播放内核与当前集。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, canPlayNext, activeLineIndex, activeEpisodeIndex, siteKey, vodId, activeLine]);


  const playExternal = async () => {
    // 开关关闭时按钮不会渲染，这里再兜一层：防止快捷键 / 旧缓存里的调用
    // 绕过 UI 直接拉起系统播放器。
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
   * ended 自动接下一集 / 用户点下一集时自然命中，切换不再等解析。
   *
   * 保守约定：并发 1；只写缓存、不占任何 UI 状态，用户发起的解析随时优先
   * （不被预解析阻塞）；暂停 / 换集 / 离页取消定时器；任何异常静默吞掉。
   * 出画信号直接听 <video> 的 playing（≈readyState>=3，与历史 effect 同一
   * 套路）——引擎没有对外的 playing 回调，不为这个信号新增内核 API。
   */
  const preResolveRef = useRef<{ timer: number | null; busy: boolean; gen: number }>({
    timer: null,
    busy: false,
    gen: 0,
  });
  /** 最新预解析目标：跟随当前线路 / 集，渲染期更新，fire 时读到的永远是最新。 */
  const preResolveTargetRef = useRef<{
    siteKey: string;
    playFrom: string;
    url: string;
  } | null>(null);
  const nextEpisodeForPreResolve =
    canPlayNext && activeLine ? activeLine.episodes[activeEpisodeIndex + 1] : null;
  preResolveTargetRef.current =
    nextEpisodeForPreResolve?.url && activeLine
      ? {
          siteKey: activeSiteKey,
          playFrom: activeLine.name,
          url: nextEpisodeForPreResolve.url,
        }
      : null;
  /** 解析中 / 手动切换在途时不去抢源侧：预解析只是锦上添花。 */
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
      // 目标没变、也没离页才写：用户已经切走时这份结果属于旧目标，写进去
      // 可能覆盖刚因 fatal 作废的条目。kind 过滤在缓存内部（page 不入）。
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
      // 换集 / 恢复播放都重新计时：旧定时器作废，从新的稳定出画再等 5s。
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
      // 离页 / 内核重建：取消定时器，gen 递增让在途预解析的结果作废。
      cancel();
      state.gen += 1;
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
    };
    // resolved 变化 = 内核重建，要把监听挂到新 <video>（内核 effect 先于本
    // effect 执行，videoRef 已是新元素）；原地换集复用同一 video，监听不变，
    // 新一集的 playing 会重新 arm。runPreResolve 引用稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, siteKey, runPreResolve]);

  useEffect(() => {
    const text = switchTip || slowNotice;
    if (!text) {
      return;
    }
    // 源侧慢的文案每 2s 变一次，跟着刷新 notice 的自动隐藏计时。
    engine.notice(text);
    // ArtPlayer 的 notice 2s 自动隐藏，而换集 / 换线解析可能要 3~50s：
    // switchTip 非空期间每 1.5s 重发一次，压过自动隐藏，提示全程常驻；
    // tip 清空即停定时器。slowNotice 自身每 2s 更新触发本 effect，不必加表。
    if (!switchTip) {
      return;
    }
    const timer = window.setInterval(() => engine.notice(text), 1500);
    return () => window.clearInterval(timer);
  }, [engine, switchTip, slowNotice]);

  /** 当前集名：剧集列表到达后用列表里的名字，否则用路由参数。 */
  const nowEpisode = activeEpisode?.name || episodeName;

  /** 片头/片尾配置改动统一入口：写 ref + 镜像 state + 齿轮行 tooltip + 即时落库。 */
  const applySkipConfig = (segs: SkipSegment[]) => {
    rememberedSkipRef.current = segs;
    setSkipConfig(segs);
    engine.setSkipSettingTooltip(formatSkipSummary(segs));
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
  // 齿轮行 tooltip 跟随当前配置（历史载入 / 弹窗改动都覆盖到）。
  useEffect(() => {
    engine.setSkipSettingTooltip(formatSkipSummary(skipConfig));
  }, [skipConfig, engine]);
  // 切换在途（乐观 episodeSwitching 或机器 switching 任一为真）→ 用 ArtPlayer 原生
  // loading 画画面转圈；收口即隐藏。实例还没建时无从调用（上层自绘解析卡片接管）。
  useEffect(() => {
    engine.setLoading(episodeSwitching || engine.switching);
  }, [episodeSwitching, engine]);

  // 「下一集」按钮：详情未到时 lines 为空，按钮先以禁用态存在——控件由内核
  // 实例创建时一次性生成，不能等剧集列表到了再「补一个」，否则永远不会出现。
  episodeNavRef.current = {
    canNext: canPlayNext,
    onNext: () => goEpisode(1),
    switching: episodeSwitching,
  };

  /* 播放舞台：画面 + 分辨率角标（角标是 portal，渲染进 ArtPlayer 根节点）。 */
  const stageNode = (
    <>
      <PlayerStage
        resolving={resolving}
        stage={stage}
        reloading={reloading}
        switching={episodeSwitching || engine.switching}
        playable={playable}
        recovering={recovering}
        pending={resolved === null}
        resolveError={switchedUrlRef.current ? "" : resolveError}
        retryable={resolveRetryable}
        containerRef={containerRef}
        poster={posterUrl ?? undefined}
        onNextLine={pickNextLine}
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
        state={skipState}
        onSkipIntro={() => {
          const v = videoRef.current;
          const intro = introMs(skipConfig);
          if (v && intro > 0) {
            try {
              v.currentTime = intro / 1000;
            } catch {
              /* seek 未就绪时忽略 */
            }
          }
        }}
        onSkipOutro={() => {
          const v = videoRef.current;
          if (v && Number.isFinite(v.duration) && v.duration > 0) {
            try {
              // 跳到结尾前 0.5s，触发既有 ended → 自动下一集。
              v.currentTime = Math.max(0, v.duration - 0.5);
            } catch {
              /* seek 未就绪时忽略 */
            }
          }
        }}
      />
      <SkipSettingsDialog
        host={playerRoot}
        open={skipSettingsOpen}
        config={skipConfig}
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
        {/* 与直播页同一口径：播放失败/解析失败是「这一下这条线路不行」的时效
          结论（自动换源可能已经把你救回来了），8s 带倒计时收起；hover 面板
          上时倒计时冻结。真正要用户决策的错误由 PlayerStage 面板常驻呈现。 */}
        {videoError && !recovering ? (
          <ErrorBar message={videoError} lifetime="timed" />
        ) : null}
        {resolveError && !recovering && !switchedUrlRef.current ? (
          <ErrorBar
            message={`播放地址解析失败：${resolveError}`}
            lifetime="timed"
          />
        ) : null}

        {stageNode}
        {/* 影片信息卡：片名/年份/简介 + 换源，紧跟在播放器下方。 */}
        <PlayerAbout
          vod={vod}
          fallbackName={activeVodName}
          siteKey={activeSiteKey}
          siteName={activeSiteName}
          lineName={activeLine?.name}
          episodeLabel={nowEpisode || undefined}
          douban={doubanMeta}
          onSwitchSource={() => setShowSources(true)}
          onPlayExternal={
            EXTERNAL_PLAY_ENABLED ? () => void playExternal() : undefined
          }
        />

        {/* 选集常驻在信息卡下面：不再需要「选集」按钮展开一层。 */}
        {activeLines.length > 0 ? (
          <EpisodePanel
            lines={activeLines}
            panelLine={panelLine}
            lineIndex={activeLineIndex}
            episodeIndex={activeEpisodeIndex}
            pendingPick={pendingPick}
            setPanelLine={setPanelLine}
            goToEpisode={goToEpisode}
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
            onPick={pickSource}
            onClose={() => setShowSources(false)}
          />
        ) : null}
      </div>
    </section>
  );
}
