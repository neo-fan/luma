import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Navigate } from "../lib/nav";
import ErrorBar from "../components/ErrorBar";
import SourcePicker from "../components/SourcePicker";
import PlayerHeader from "../components/player/PlayerHeader";
import PlayerStage from "../components/player/PlayerStage";
import PlayerAbout from "../components/player/PlayerAbout";
import EpisodePanel from "../components/player/EpisodePanel";
import PlayerResolution from "../components/player/PlayerResolution";
import { parsePlayLines, sameEpisodeName, sameTitle, toVodRef } from "../lib/format";
import type { PlayLine } from "../lib/format";
import { pickMatchingEpisode } from "../lib/sources";
import { EXTERNAL_PLAY_ENABLED, PLAY_FAILURE_HINT } from "../lib/features";
import { resolveEpisodeTarget } from "../lib/episodeResolve";
import {
  getEpisodePlayCache,
  invalidateEpisodePlayCache,
  setEpisodePlayCache,
} from "../lib/episodePlayCache";
import { buildImageUrl, needsProxy, normalizePic } from "../lib/imageUrl";
import { getProxyBaseUrl, resolveProxiedImageSync } from "../hooks/useProxiedImage";
import { probePlayable } from "../lib/playProbe";
import { firstPlayable } from "../lib/probeRace";
import { lineRank } from "../lib/lineHealth";
import {
  consumeAutoNav,
  ledgerBudget,
  ledgerCountSwitch,
  ledgerHasUrl,
  ledgerMarkSite,
  ledgerMarkUrl,
  ledgerReset,
  ledgerSiteSeen,
  ledgerSuccess,
  markAutoNav,
} from "../lib/failoverLedger";
import {
  resolutionBadge,
  resolutionDetail,
  resolutionFromVideo,
} from "../lib/resolution";
import type { VideoMeta } from "../lib/resolution";

import { prefetchSources } from "../lib/sourceCache";
import { log } from "../lib/logger";
import { notify } from "../lib/notify";
import type { SourceOption } from "../lib/sources";
import { api, errorMessage } from "../lib/invoke";
import { fetchDoubanMeta } from "../lib/douban";
import type { DoubanMeta } from "../lib/douban";
import type { HistoryItem, PlayResolved, ResultPage, Site, VodInfo } from "../types/luma";
import { usePlayResolution } from "../hooks/usePlayResolution";
import { usePlaybackIndicator } from "../hooks/usePlaybackIndicator";
import { useEpisodeList } from "../hooks/useEpisodeList";
import { usePlayerEngine, BUILTIN_KINDS } from "../hooks/usePlayerEngine";
import type { EpisodeNavControl } from "../hooks/usePlayerEngine";

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
  /**
   * 原地换集进行中（resolve → switchSource 全程 true）：控制栏钉住不自动收起、
   * 「下一集」按钮转圈、吞掉重复点击。没有它，点击后的 1~50s 里唯一反馈是一条
   * 会闪 2 秒的 notice，用户读作「点了没反应」（2026-11-16 反馈）。
   */
  const [episodeSwitching, setEpisodeSwitching] = useState(false);
  /**
   * 「切换中」的同步真源。
   *
   * 为什么不能只靠上面的 state：state 要等本次渲染提交后才读得到，用户在同一
   * tick（或一次重渲染之前）连点两下「下一集」时，两次 `goToEpisode` 读到的
   * `episodeSwitching` 都是 false —— 双路 `switchSource` 协程并发起飞、互相覆盖
   * （后完成者赢），正是注释里反复要防的「点了没反应 / 画面切回旧集」。控制栏
   * click 那道守卫读的是 `episodeNavRef.current.switching`，而 `episodeNavRef`
   * 只在 render 期赋值，同样慢一拍。
   *
   * 所以锁走 ref（写入同步），`episodeSwitching` state 仅用于渲染按钮转圈与
   * PlayerStage 覆盖层。二者一律通过 `markSwitching` 一起改，不允许分别 set，
   * 否则锁与视图会分叉。
   */
  const switchingRef = useRef(false);
  /** 切换代次：只有最新一次切换的收尾才允许解除「切换中」，防在途旧协程误清。 */
  const episodeSwitchGenRef = useRef(0);
  /** 统一改「切换中」：ref 当场生效（挡重复点击），state 负责渲染，ref 镜像喂控制栏守卫。 */
  const markSwitching = useCallback((value: boolean) => {
    switchingRef.current = value;
    // episodeNavRef 此刻已指向上一轮渲染写入的对象；直接改字段，让控制栏 click
    // 在重渲染之前就读到最新的 switching，而不是等 render 期重新赋值。
    if (episodeNavRef.current) {
      episodeNavRef.current.switching = value;
    }
    setEpisodeSwitching(value);
  }, []);
  /**
   * 「切换中」的兜底解除：完成路径（switchSource 出画 / 15s 封顶 / 退回重建）
   * 都收不回 true 的极端情况（HMR 丢掉在途 promise、异常路径遗漏）会把控制栏
   * 永久钉住、按钮永远转圈。30s 后强制解除并收回提示。
   */
  useEffect(() => {
    if (!episodeSwitching) {
      return;
    }
    const timer = window.setTimeout(() => {
      markSwitching(false);
      setSwitchTip("");
    }, 30000);
    return () => window.clearTimeout(timer);
  }, [episodeSwitching, markSwitching]);
  /**
   * 冷路径「下一集」走 `fallback()` → navigate 重建整页：路由 `playUrl` 一变就
   * 代表新页面接管了加载态，这里释放切换锁，否则按钮会被钉到 30s 兜底才转停。
   * 原地快路径不改 `playUrl`（见 switchedUrlRef 注释），由协程 finally 释放，
   * 两条路径各管各的，不会互相误清。
   */
  useEffect(() => {
    if (switchingRef.current) {
      markSwitching(false);
    }
    // 仅跟随路由集身份变化触发；markSwitching 恒定，不需要进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playUrl]);
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
  const switchedUrlRef = useRef<string | null>(null);
  /**
   * 当前真正在播的「集身份」（站点 / 线路 / 集地址）。原地换集 / 换源后路由
   * 参数是旧的，播放 fatal 要按这份身份作废解析缓存，否则作废的是上一集。
   */
  const playingEpisodeRef = useRef({ siteKey, playFrom, url: playUrl });
  /**
   * 立即写一次历史的通道。切集 / 换源会用 navigate 重建本页，若只靠 5 秒
   * 节流，切换瞬间的进度可能丢；history effect 把 write 挂到这里，
   * goToEpisode / pickSource / 自动换线跳转前先 flush 一次。
   */
  const flushHistoryRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const history = await api.historyList();
        // 历史按「剧名完全匹配」去重，一部剧只留一条（换源后 siteKey/vodId
        // 会变）。因此续播先按剧名定位，再确认记录的仍是同一集：同集才跳进度，
        // 换集时不该把上一集的进度套到新集上。
        const title = vodName.trim();
        const hit = title
          ? history.find((item) => item.name?.trim() === title)
          : undefined;
        const sameEpisode =
          hit?.playUrl === playUrl ||
          Boolean(hit?.episodeName && hit.episodeName === episodeName);
        if (
          !alive ||
          !hit?.positionMs ||
          hit.positionMs <= 3000 ||
          !sameEpisode
        ) {
          return;
        }
        // 刷新路径已写入更准确的当前进度，别被异步到达的历史覆盖。
        if (resumeMsRef.current !== 0) {
          return;
        }
        const video = videoRef.current;
        if (video && video.readyState >= 1 && video.currentTime < 1) {
          // 历史比 loadedmetadata 晚到：内核已消费过 ref，这里直接补跳。
          video.currentTime = hit.positionMs / 1000;
        } else {
          resumeMsRef.current = hit.positionMs;
        }
      } catch {
        // 历史读不到就从头播，不打断播放。
      }
    })();
    return () => {
      alive = false;
    };
  }, [siteKey, vodId, playUrl, vodName, episodeName]);

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
  const activeLineIndex =
    manualPick?.lineIndex ?? switchedSource?.lineIndex ?? lineIndex;
  const activeEpisodeIndex =
    manualPick?.episodeIndex ?? switchedSource?.episodeIndex ?? episodeIndex;
  const activeLine = activeLines[activeLineIndex] ?? currentLine;
  const activeEpisode = activeLine?.episodes[activeEpisodeIndex];
  const activeEpisodeName = activeEpisode?.name || episodeName;
  const canPlayNext = Boolean(
    activeLine && activeEpisodeIndex + 1 < activeLine.episodes.length,
  );

  /**
   * 首帧前海报：影片封面过 /image 代理（防盗链 / 内联 header），供播放内核
   * 构造 poster 与舞台解析期背景共用。URL 构造是 lib/imageUrl 的纯函数，
   * 代理端口复用 useProxiedImage 导出的 getProxyBaseUrl（非 hook 的进程级
   * 单例，不在引擎里引 React hook）。封面缺失 / 代理不可用时退化为直连或
   * 无海报，绝不阻塞播放。
   */
  const [posterUrl, setPosterUrl] = useState<string | null>(() =>
    // 首帧同步解析：详情有 pageCache 种子、代理端口有进程级缓存时，remount
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
  }, [vod?.vod_name, vod?.vod_year, vodName]);

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
  const probeCandidate = useCallback(
    async (
      key: string,
      candidate: { line: string; url: string },
      signal: AbortSignal,
    ): Promise<boolean> => {
      try {
        const target = await resolveEpisodeTarget(
          key,
          candidate.line,
          candidate.url,
        );
        if (target.unresolvable || signal.aborted) {
          // 网盘 token 类线路：源自己都不认，别浪费一次 resolve_play。
          return false;
        }
        const probe = await api.resolvePlay({
          siteKey: key,
          url: target.url,
          ua: target.ua,
          referer: target.referer,
          cookie: target.cookie,
        });
        if (probe.kind === "page" || signal.aborted) {
          return false;
        }
        // 别把死 CDN / 假地址当成「可播放线路」：网盘解析接口会以 200 + JSON
        // 返回「解析失败了」，只看状态码会误判成可播线路。
        const ok = await probePlayable(probe.proxyUrl, probe.kind);
        if (ok) {
          // 探活已经跑完整条解析链：预热按集缓存，navigate 重挂载后新页面的
          // 首次解析直接命中，不再重跑 playerContent → resolve_play。
          setEpisodePlayCache(key, candidate.line, candidate.url, probe);
        }
        return ok;
      } catch {
        return false;
      }
    },
    [],
  );

  const tryFailover = useCallback(async () => {
    if (failoverStarted.current) {
      return;
    }
    failoverStarted.current = true;
    // 换源接管：收回可能挂着的「换集进行中」，否则控制栏会被钉住到兜底超时。
    episodeSwitchGenRef.current += 1;
    markSwitching(false);
    // `changeable: 0`：配置明确不允许换源，别再对其它站点发搜索。
    if (!allowFailover) {
      setSwitchTip("");
      setVideoError("该源不允许换源，请手动切换播放线路或稍后重试。");
      return;
    }
    const name = vodName.trim();
    if (!name) {
      return;
    }
    setSwitchTip("当前源无法播放，正在寻找其它可用源…");
    try {
      const agg = (await api.spiderInvoke({
        siteKey: "all",
        method: "searchContent",
        args: [name, false, 1],
        timeoutMs: 6000,
      })) as {
        results?: { siteKey: string; ok: boolean; data?: ResultPage }[];
      };

      const candidates = (agg.results ?? [])
        .filter((item) => item.ok && item.data)
        .flatMap((item) =>
          (item.data?.list ?? [])
            .filter(
              (vod) =>
                vod.vod_name &&
                (vod.vod_name.includes(name) || name.includes(vod.vod_name)),
            )
            .slice(0, 1)
            .map((vod) => ({ siteKey: item.siteKey, vod })),
        )
        .filter((item) => !ledgerSiteSeen(ledgerKey, item.siteKey));

      for (const candidate of candidates.slice(0, 8)) {
        ledgerMarkSite(ledgerKey, candidate.siteKey);
        try {
          const detail = await api.detail(
            candidate.siteKey,
            String(candidate.vod.vod_id),
          );
          const vod = detail[0];
          if (!vod) {
            continue;
          }
          const nextLines = parsePlayLines(vod.vod_play_from, vod.vod_play_url);
          // 第一个候选常是分享页；把同片前几条线路都探一遍再决定。
          // 线路名与剧集成对保留：跨站同样要先过 playerContent。
          const ordered = nextLines
            .flatMap((line) =>
              line.episodes.map((episode) => ({ line: line.name, episode })),
            )
            .sort((a, b) => {
              // 同名剧集优先；同集之间按线路健康度排（最近解开的排前面）。
              const sameEpisode =
                Number(b.episode.name === episodeName) -
                Number(a.episode.name === episodeName);
              if (sameEpisode !== 0) {
                return sameEpisode;
              }
              return (
                lineRank(candidate.siteKey, a.line) -
                lineRank(candidate.siteKey, b.line)
              );
            });
          const candidatesOfSite = ordered
            .filter(
              ({ episode }) =>
                Boolean(episode.url) && !ledgerHasUrl(ledgerKey, episode.url),
            )
            .slice(0, 8)
            .map(({ line, episode }) => ({
              line,
              name: episode.name,
              url: episode.url,
            }));
          // 并发探活：第一个能播的立刻返回。串行时「每条失败线路 2–5 秒」会
          // 让用户对着转圈等十几秒，实际只有一条是通的。
          const picked = await firstPlayable(
            candidatesOfSite,
            (item, signal) => probeCandidate(candidate.siteKey, item, signal),
            { concurrency: 4 },
          );
          if (!picked) {
            continue;
          }
          const tip = `已自动切换到「${candidate.siteKey}」`;
          log.info("auto failover", {
            from: siteKey,
            to: candidate.siteKey,
            vodId: String(candidate.vod.vod_id),
          });
          window.sessionStorage.setItem("luma:autoSwitch", tip);
          setSwitchTip(tip);
          ledgerMarkUrl(ledgerKey, picked.url);
          ledgerCountSwitch(ledgerKey);
          videoRef.current = null;
          navigate(
            {
              name: "player",
              siteKey: candidate.siteKey,
              vodId: String(candidate.vod.vod_id),
              vodName: vod.vod_name || candidate.vod.vod_name,
              episodeName: picked.name,
              playUrl: picked.url,
              // 跨站换源同样要带上线路名，否则新站点这次的地址解析又退化成
              // 「把私有 token 当 URL」。
              playFrom: picked.line,
              // 记账 key 透传：试过的地址/站点/次数跨站继续生效，防 A↔B 横跳。
              failoverKey: ledgerKey,
            },
            true,
          );
          return;
        } catch {
          continue;
        }
      }
      setSwitchTip("");
      setVideoError(`所有源都无法播放该影片，${PLAY_FAILURE_HINT}。`);
    } catch (err) {
      setSwitchTip("");
      setVideoError(`换源失败：${errorMessage(err)}`);
    }
  }, [episodeName, navigate, vodName, siteKey, allowFailover, ledgerKey, markSwitching]);

  /**
   * 真实配置里同一部剧常有多条线路：第一条是「分享页」，第二条才是直链
   * m3u8；也有线路 HTTP 探活 200 但 manifest 永远拉不出来。两条路径
   * （kind=page、HLS 长时间 stalled）都先切同片线路，找不到再跨站换源。
   *
   * 顺序是产品口径：**当前源的同一集 → 当前源的其它集 → 跨站换源**。
   * 同一轮里的失败信号经常前后脚到（HLS fatal 之后紧跟 kind=page），所以
   * 重复进入时要**等**正在进行的那一次结论，而不是当它「失败」直接跨源。
   */
  const tryNextLine = useCallback(async (): Promise<boolean> => {
    const inflight = lineAttempt.current;
    if (inflight) {
      return inflight;
    }
    lineSwitchStarted.current = true;
    const attempt = (async (): Promise<boolean> => {
      ledgerMarkUrl(ledgerKey, playUrl);

      // 线路名必须跟着每条剧集一起走：`PAN1-…` / `zijianm3u8-…` 这类地址只有
      // 交给对应线路的 playerContent 才能变成直链，脱掉线路名就等于把私有 token
      // 当 URL 解析（实测一次换线路能刷出 11 条 "play url is invalid"，且真正
      // 可播的线路被整条跳过）。
      type Candidate = { line: string; episode: { name: string; url: string } };
      let episodes: Candidate[] = lines.flatMap((line) =>
        line.episodes.map((episode) => ({ line: line.name, episode })),
      );
      if (episodes.length === 0) {
        try {
          const detail = await api.detail(siteKey, vodId);
          const vod = detail[0];
          if (vod) {
            episodes = parsePlayLines(
              vod.vod_play_from,
              vod.vod_play_url,
            ).flatMap((line) =>
              line.episodes.map((episode) => ({ line: line.name, episode })),
            );
          }
        } catch {
          // 详情拿不到就直接走跨站换源。
        }
      }

      // 集名要按「同一集」归一后比较：`第04集` / `第4集` / `EP01` 是同一集，
      // 只做字符串相等会把它们判成「别的集」，排序退化后竞速就可能切到别的集。
      const usable = episodes
        .filter(
          ({ episode }) =>
            Boolean(episode.url) && !ledgerHasUrl(ledgerKey, episode.url),
        )
        .map(({ line, episode }) => ({
          line,
          name: episode.name,
          url: episode.url,
          sameEpisode: sameEpisodeName(episode.name, episodeName),
        }))
        .sort((a, b) => {
          if (a.sameEpisode !== b.sameEpisode) {
            return Number(b.sameEpisode) - Number(a.sameEpisode);
          }
          // 同集的不同线路：把最近解码成功的排前面，判过死 token 的排最后。
          return lineRank(siteKey, a.line) - lineRank(siteKey, b.line);
        });

      // 阶段一：当前源、当前这一集的不同线路（真正意义上的「换线路」）。
      // 阶段二：当前源的其它集（源把剧集表切错时也能救回来）。
      const sameEpisode = usable
        .filter((item) => item.sameEpisode)
        .slice(0, 12);
      const otherEpisodes = usable
        .filter((item) => !item.sameEpisode)
        .slice(0, 8);
      const probe = (item: { line: string; url: string }, signal: AbortSignal) =>
        probeCandidate(siteKey, item, signal);

      // 并发探活（首个成功即中止其余）：串行时「布布追剧 → 走马上任」第 3 集要
      // 16 秒才出画，用户以为坏了；现在是最快那条线路的耗时。
      setSwitchTip("正在尝试同源的其它线路…");
      let picked = sameEpisode.length
        ? await firstPlayable(sameEpisode, probe, { concurrency: 4 })
        : null;
      if (!picked && otherEpisodes.length) {
        setSwitchTip("当前源没有同集可播线路，正在尝试其它集…");
        picked = await firstPlayable(otherEpisodes, probe, { concurrency: 4 });
      }
      if (!picked) {
        return false;
      }
      ledgerMarkUrl(ledgerKey, picked.url);
      ledgerCountSwitch(ledgerKey);
      markAutoNav();
      setSwitchTip(`已自动切换到可播放线路「${picked.name}」`);
      videoRef.current = null;
      navigate(
        {
          name: "player",
          siteKey,
          vodId,
          vodName,
          episodeName: picked.name,
          playUrl: picked.url,
          // 切换后必须保留线路名，否则下一次解析又拿不到 playerContent。
          playFrom: picked.line,
          // 同站换线也透传 key：跳转目标页据此知道不是手动点播，不清账。
          failoverKey: ledgerKey,
        },
        true,
      );
      return true;
    })();
    lineAttempt.current = attempt;
    try {
      return await attempt;
    } finally {
      lineSwitchStarted.current = false;
      if (lineAttempt.current === attempt) {
        lineAttempt.current = null;
      }
    }
  }, [
    episodeName,
    lines,
    navigate,
    playUrl,
    siteKey,
    vodId,
    vodName,
    ledgerKey,
  ]);

  /** 线路切换失败后的兜底：整站找同名影片。 */
  const switchOrFailover = useCallback(async () => {
    // 走到这里说明播放 fatal（hls fatal / 解码失败 / 看门狗判死）：当前地址
    // 的解析结论不可信，作废按集缓存，避免换集 / remount 又命中坏地址。
    // 按「真正在播的集」作废——原地换集后路由参数已是上一集。
    const playing = playingEpisodeRef.current;
    invalidateEpisodePlayCache(playing.siteKey, playing.playFrom, playing.url);
    // 跳转次数预算用完就停：之前没有上限，跨站记账又失效，会出现
    // 「一直在切换」的无限横跳；现在最多 4 次，之后把控制权交还用户。
    if (ledgerBudget(ledgerKey) <= 0) {
      setSwitchTip("");
      setVideoError(
        "已自动尝试多条线路和多个源仍无法播放，请手动切换线路或换一集。",
      );
      return;
    }
    const switched = await tryNextLine();
    if (!switched) {
      // 阶段文案要跟上实际行为：先穷尽同源线路，才轮到跨站换源。
      setSwitchTip("当前源没有可播线路，正在尝试其它源…");
      await tryFailover();
    }
  }, [tryNextLine, tryFailover, ledgerKey]);

  /** 面板里的「换下一条线路」：和自动换线走同一条通道，但由用户触发、不记账。 */
  const [nextLineBusy, setNextLineBusy] = useState(false);
  const pickNextLine = useCallback(() => {
    if (nextLineBusy) {
      return;
    }
    setNextLineBusy(true);
    // 手动换线接管：同 tryFailover，收回挂起的「换集进行中」。
    episodeSwitchGenRef.current += 1;
    markSwitching(false);
    setSwitchTip("正在切换到下一条线路…");
    void tryNextLine()
      .then((switched) => {
        if (!switched) {
          setSwitchTip("");
          setVideoError("当前源没有其它可播线路了，可以换一个源或稍后重试。");
        }
      })
      .finally(() => setNextLineBusy(false));
  }, [nextLineBusy, tryNextLine, markSwitching]);

  // tryNextLine 依赖异步加载的剧集列表；用 ref 转发，避免播放内核 effect
  // 因 lines 到达而被重新挂载（那会从头开始缓冲）。
  const switchOrFailoverRef = useRef(switchOrFailover);
  switchOrFailoverRef.current = switchOrFailover;

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

  // 常驻层切页不卸载播放器：播放状态进全局 store，侧栏图标才能亮小圆点。
  usePlaybackIndicator(videoRef, "vod", resolved);

  // 换集 / 换源后旧分辨率不属于新画面：先清空，等新一集 `loadedmetadata`
  // 再上报，避免切集瞬间角标还挂着上一集的 1080P。
  useEffect(() => {
    setVideoMeta({ width: 0, height: 0 });
  }, [resolved]);

  // 播放进度 → 历史记录（5 秒节流，播放/暂停立即写）。
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !resolved) {
      return;
    }

    let lastWrite = 0;
    /**
     * 本次播放已确认的分辨率。
     *
     * 直接从当前 `<video>` 读解码尺寸：切集瞬间 `videoWidth` 会变回 0，这一
     * 帧写入的历史若带上空串就会把上一条记录的分辨率抹掉（后端也做了同样的
     * 空值保护），所以再留一份最近值兜底。
     */
    let knownResolution = resolutionFromVideo(video);
    /** 卸载时 ArtPlayer 已清掉 src，最后一次写入用快照，不重读 currentTime。 */
    const write = async (
      force: boolean,
      snapshot?: { positionMs: number; durationMs?: number },
    ) => {
      const now = Date.now();
      if (!force && now - lastWrite < 5000) {
        return;
      }
      lastWrite = now;
      knownResolution = resolutionFromVideo(video) || knownResolution;
      const item: HistoryItem = {
        siteKey: activeSiteKey,
        vodId: activeVodId,
        name: activeVodName,
        pic: historyMetaRef.current.pic,
        remarks: historyMetaRef.current.remarks,
        siteName: historyMetaRef.current.siteName,
        playUrl,
        episodeName: historyLabelRef.current.episodeName,
        playFrom: historyLabelRef.current.playFrom,
        resolution: knownResolution,
        positionMs:
          snapshot?.positionMs ?? Math.round(video.currentTime * 1000),
        durationMs:
          snapshot?.durationMs ??
          (Number.isFinite(video.duration)
            ? Math.round(video.duration * 1000)
            : undefined),
        updatedAt: now,
      };
      try {
        await api.historyUpsert(item);
      } catch {
        // 历史写入失败不应打断播放。
      }
    };

    flushHistoryRef.current = () => {
      void write(true);
    };

    const onPlay = () => {
      void write(true);
    };
    const onPause = () => {
      void write(true);
    };
    const onTimeUpdate = () => {
      // 顶部时间标签已移除（播放器控制栏自带进度），这里只维护卸载用的
      // 进度快照并节流写历史，不再触发每秒一次的整页重渲染。
      lastMediaRef.current.positionMs = Math.round(video.currentTime * 1000);
      if (Number.isFinite(video.duration)) {
        lastMediaRef.current.durationMs = Math.round(video.duration * 1000);
      }
      void write(false);
    };
    const onMeta = () => {
      // loadedmetadata = 媒体真正可解码，本线路确认可播：连续失败链中断，
      // 自动换线跳转预算恢复满额（failoverLedger 的「连续失败」语义）。
      ledgerSuccess(ledgerKey);
      if (Number.isFinite(video.duration)) {
        lastMediaRef.current.durationMs = Math.round(video.duration * 1000);
      }
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("loadedmetadata", onMeta);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("loadedmetadata", onMeta);
      void write(true, lastMediaRef.current);
    };
  }, [resolved, activeSiteKey, activeVodId, activeVodName, playUrl, ledgerKey]);

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

  /**
   * 选集面板里点任意线路 / 任意一集。
   *
   * 优先原地换：解析出新地址后交给同一个 ArtPlayer 实例（`engine.switchSource`），
   * 控制栏、全屏、音量都不重建——重建后没有用户手势，全屏再也进不去。
   * 只有解析失败、类型变化或播放器还没就绪时才退回整页 navigate。
   */
  const goToEpisode = (targetLine: number, index: number) => {
    // 一次只跑一个切换协程：双路 switchUrl 竞态会互相覆盖（后完成者赢），
    // 用户看到「画面切回旧集」。读 ref 而不是 state——同一 tick 内的第二次点击
    // 还看不到上一次 setEpisodeSwitching 的结果，state 守卫会漏。控制栏按钮侧
    // 另有 click 守卫（读 episodeNavRef.current.switching，已被 markSwitching
    // 当场改写），这里兜住选集面板与自动换集入口。
    if (switchingRef.current) {
      return;
    }
    const target = activeLines[targetLine];
    if (!target || index < 0 || index >= target.episodes.length) {
      return;
    }
    const episode = target.episodes[index];
    // 立刻上锁并点亮 loading，且必须在下面 `!resolved` 分支之前——冷路径直接
    // navigate 重建，若等到快路径才置真，这一路既不转圈也不挡连点。
    markSwitching(true);
    flushHistoryRef.current?.();
    setManualPick({ lineIndex: targetLine, episodeIndex: index });
    setSwitchTip(`正在切换到「${episode.name}」…`);

    const fallback = () => {
      setManualPick(null);
      setSwitchTip("");
      videoRef.current = null;
      navigate(
        {
          name: "player",
          siteKey: activeSiteKey,
          vodId: activeVodId,
          vodName: activeVodName,
          playUrl: episode.url,
          episodeName: episode.name,
          playFrom: target.name,
        },
        true,
      );
    };

    if (!resolved) {
      fallback();
      return;
    }
    const previousKind = resolved.kind;
    const gen = episodeSwitchGenRef.current + 1;
    episodeSwitchGenRef.current = gen;
    void (async () => {
      try {
        // 按集缓存：预解析 / 探活 / 上次访问可能已解析过这一集。命中且类型
        // 兼容就跳过整条 playerContent → resolve_play 链，直接原地换源。
        const cached = getEpisodePlayCache(activeSiteKey, target.name, episode.url);
        let play: PlayResolved;
        if (cached && cached.kind === previousKind && cached.kind !== "page") {
          play = cached;
        } else {
          const next = await resolveEpisodeTarget(activeSiteKey, target.name, episode.url);
          if (next.unresolvable) {
            throw new Error("线路不可解析");
          }
          play = await api.resolvePlay({
            siteKey: activeSiteKey,
            url: next.url,
            ua: next.ua,
            referer: next.referer,
            cookie: next.cookie,
          });
          if (play.kind !== previousKind || play.kind === "page") {
            throw new Error(`播放类型变化：${previousKind} → ${play.kind}`);
          }
          setEpisodePlayCache(activeSiteKey, target.name, episode.url, play);
        }
        resumeMsRef.current = 0;
        await engine.switchSource(play.proxyUrl);
        switchedUrlRef.current = play.proxyUrl;
        playingEpisodeRef.current = {
          siteKey: activeSiteKey,
          playFrom: target.name,
          url: episode.url,
        };
        setSwitchTip("");
      } catch (err) {
        // 原地切换失败要退回整页重建：这份解析结论（可能来自缓存）已不可信，
        // 作废掉，免得新页面首次解析又命中同一个坏地址。
        invalidateEpisodePlayCache(activeSiteKey, target.name, episode.url);
        log.warn("in-place episode switch failed", {
          message: errorMessage(err),
        });
        fallback();
      } finally {
        // 出画 / 退回整页重建 / 15s 封顶：三条路都要收回「切换中」态；
        // 被更新的切换（或换线/换源接管）顶掉代次时不清——那是别人的状态。
        if (episodeSwitchGenRef.current === gen) {
          markSwitching(false);
        }
      }
    })();
  };

  const goEpisode = (delta: number) => {
    if (!activeLine) {
      return;
    }
    goToEpisode(activeLineIndex, activeEpisodeIndex + delta);
  };

  /**
   * 手动换源：用户选定站点后取该站详情，尽量续播同一集（同名 / 同集号 /
   * 同序号），不探活也不抢答——选哪个源由用户决定，失败仍走原有兜底链路。
   */
  const pickSource = async (option: SourceOption) => {
    setShowSources(false);
    // 换源要先取新站详情，可能几秒：只在页面上留一行提示，不盖全屏、
    // 不压暗播放器 —— 视频加载交给播放器自己显示。
    setSwitchTip(`正在切换到「${option.siteName}」…`);
    let matched: ReturnType<typeof pickMatchingEpisode> | null = null;
    let nextLines: PlayLine[] = [];
    try {
      const list = await api.detail(option.siteKey, option.vodId);
      nextLines = list?.[0]
        ? parsePlayLines(list[0].vod_play_from, list[0].vod_play_url)
        : [];
      matched = pickMatchingEpisode(nextLines, {
        name: activeEpisodeName,
        index: activeEpisodeIndex,
      });
    } catch (err) {
      setSwitchTip("");
      notify.error(`换源失败：${errorMessage(err)}`);
      return;
    }
    const match = matched;
    if (!match) {
      setSwitchTip("");
      notify.error("该源没有可播放剧集，请换一个片源");
      return;
    }
    log.info("manual source switch", {
      from: activeSiteKey,
      to: option.siteKey,
      vodId: option.vodId,
      episode: activeEpisodeName,
    });
    // 换源前先落库：历史按剧名合并，这条进度就是新源的续播起点。
    flushHistoryRef.current?.();
    const nextVodName = option.vodName || activeVodName;
    const nextSiteKey = option.siteKey;
    // 兜底：新线路解析失败（跨协议 / 还没拿到播放器）才整页重建。
    const fallback = () => {
      setSwitchedSource(null);
      setSwitchTip("");
      videoRef.current = null;
      navigate(
        {
          name: "player",
          siteKey: nextSiteKey,
          vodId: option.vodId,
          vodName: nextVodName,
          playUrl: match.episode.url,
          episodeName: match.episode.name,
          playFrom: match.line.name,
        },
        true,
      );
    };
    if (!resolved) {
      fallback();
      return;
    }
    const previousKind = resolved.kind;
    try {
      // 与换集同口径：跨站探活可能已预热过目标站的这一集，命中即跳过解析链。
      const cached = getEpisodePlayCache(nextSiteKey, match.line.name, match.episode.url);
      let play: PlayResolved;
      if (cached && cached.kind === previousKind && cached.kind !== "page") {
        play = cached;
      } else {
        const next = await resolveEpisodeTarget(
          nextSiteKey,
          match.line.name,
          match.episode.url,
        );
        if (next.unresolvable) {
          throw new Error("线路不可解析");
        }
        play = await api.resolvePlay({
          siteKey: nextSiteKey,
          url: next.url,
          ua: next.ua,
          referer: next.referer,
          cookie: next.cookie,
        });
        if (play.kind !== previousKind || play.kind === "page") {
          throw new Error(`播放类型变化：${previousKind} → ${play.kind}`);
        }
        setEpisodePlayCache(nextSiteKey, match.line.name, match.episode.url, play);
      }
      resumeMsRef.current = 0;
      await engine.switchSource(play.proxyUrl);
      switchedUrlRef.current = play.proxyUrl;
      playingEpisodeRef.current = {
        siteKey: nextSiteKey,
        playFrom: match.line.name,
        url: match.episode.url,
      };
      setSwitchedSource({
        siteKey: nextSiteKey,
        siteName: option.siteName,
        vodId: option.vodId,
        vodName: nextVodName,
        lines: nextLines,
        lineIndex: Math.max(0, nextLines.indexOf(match.line)),
        episodeIndex: nextLines.indexOf(match.line) >= 0 ? match.index : 0,
      });
      setManualPick(null);
      setSwitchTip("");
    } catch (err) {
      // 同换集：失败的解析结论（可能来自缓存）作废，重建后的页面重新解析。
      invalidateEpisodePlayCache(nextSiteKey, match.line.name, match.episode.url);
      log.warn("in-place source switch failed", { message: errorMessage(err) });
      fallback();
    }
  };

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
        switching={engine.switching}
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
