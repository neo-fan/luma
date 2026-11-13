import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Navigate } from "../App";
import ErrorBar from "../components/ErrorBar";
import SourcePicker from "../components/SourcePicker";
import PlayerHeader from "../components/player/PlayerHeader";
import PlayerStage from "../components/player/PlayerStage";
import PlayerAbout from "../components/player/PlayerAbout";
import EpisodePanel from "../components/player/EpisodePanel";
import PlayerResolution from "../components/player/PlayerResolution";
import LiveEpgPanel from "../components/LiveEpgPanel";
import { formatDuration, parsePlayLines, toVodRef } from "../lib/format";
import { pickMatchingEpisode } from "../lib/sources";
import { EXTERNAL_PLAY_ENABLED, PLAY_FAILURE_HINT } from "../lib/features";
import { resolveEpisodeTarget } from "../lib/episodeResolve";
import { probePlayable } from "../lib/playProbe";
import { resolutionBadge, resolutionDetail, resolutionFromVideo } from "../lib/resolution";
import type { VideoMeta } from "../lib/resolution";

import { prefetchSources } from "../lib/sourceCache";
import { log } from "../lib/logger";
import type { SourceOption } from "../lib/sources";
import { api, errorMessage } from "../lib/invoke";
import { setLiveLine } from "../lib/liveMemory";
import type { HistoryItem, PlayResolved, ResultPage, Site, VodInfo } from "../types/tvbox";
import { usePlayResolution } from "../hooks/usePlayResolution";
import { useEpisodeList } from "../hooks/useEpisodeList";
import { usePlayerEngine, BUILTIN_KINDS } from "../hooks/usePlayerEngine";
import type { LiveLineControl } from "../hooks/usePlayerEngine";

interface PlayerPageProps {
  siteKey: string;
  vodId: string;
  vodName: string;
  episodeName: string;
  playUrl: string;
  /** TVBox 线路名；有值时先走 playerContent 解析，再交给本地代理。 */
  playFrom?: string;
  /** 直播源声明的 UA，直接用于播放请求（没有 playerContent 可问）。 */
  liveUa?: string;
  /** 直播频道在源里的全部可播放地址（线路）；多于 1 条时支持手动/自动切换。 */
  liveLines?: string[];
  /** 当前直播线路序号（LivePage 带过来的记住值或默认 0）。 */
  liveLine?: number;
  /** 直播线路记忆的源标识（与 LivePage 一致）。 */
  liveSource?: string;
  /** 站点 `changeable: 0` 时禁止跨站自动换源；缺省允许。手动换源不受限。 */
  allowFailover?: boolean;
  /** 手动换源需要站点清单做名称映射与可用性过滤。 */
  sites: Site[];
  siteName?: string;
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
  liveUa,
  liveLines,
  liveLine,
  liveSource,
  allowFailover = true,
  sites,
  siteName,
  navigate,
  onBack,
}: PlayerPageProps) {
  /** ArtPlayer 托管原生 <video>；换源、兜底、历史逻辑仍基于它。 */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** 卸载时 ArtPlayer 会清掉 src，进度必须独立留一份快照。 */
  const lastMediaRef = useRef<{ positionMs: number; durationMs?: number }>({ positionMs: 0 });
  /** ArtPlayer 挂载点；实例会在这个容器里生成真正的 <video>。 */
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [videoError, setVideoError] = useState("");
  const [switchTip, setSwitchTip] = useState("");
  /** 本次挂载是否已从 sessionStorage 恢复过一次性提示。 */
  const tipRestored = useRef(false);
  const triedSites = useRef<string[]>([]);
  const failoverStarted = useRef(false);
  /** 已经自动处理过的地址，避免切线路 / 换源之间来回跳转。 */
  const handledUrls = useRef<Set<string>>(new Set());
  /** T-30：解码失败只自动转 mpv 一次，避免用户手动关掉后被反复拉起。 */
  const mpvTried = useRef(false);
  /** 同一轮播放只允许一次「找下一条线路」，防止多个失败信号并发触发。 */
  const lineSwitchStarted = useRef(false);
  /**
   * 直播线路切换的「最新值」通道：控制栏按钮由播放内核一次性建好，
   * 回调与线路数组通过 ref 传递，避免它们进 effect 依赖把播放器整个重建。
   * 实际赋值在 pickLiveLine 定义之后（render 期间完成，effect 执行时已是新值）。
   */
  const liveLineRef = useRef<LiveLineControl | null>(null);

  /**
   * 分辨率角标：数据只能从播放内核里的 `<video>` 读到（解码后的真实尺寸），
   * 由内核通过 `onVideoMeta` 上报；`playerRoot` 是 ArtPlayer 的模板根节点，
   * 也是全屏请求的对象，角标 portal 进它才能在满屏时仍然可见。
   */
  const [playerRoot, setPlayerRoot] = useState<HTMLDivElement | null>(null);
  const [videoMeta, setVideoMeta] = useState<VideoMeta>({ width: 0, height: 0 });

  /**
   * 自动换线路过程中为 true：这段时间画面上的红色错误条先不渲。
   *
   * 换线路是「有希望自愈」的过程，用户看到「播放失败」再看着它自己消失，
   * 比直接等他三秒更让人怀疑。切换以 navigate 结束（新页面 recovering 归零），
   * 若线路全灭则复位，让错误重新出现。
   */
  const [recovering, setRecovering] = useState(false);
  const [showSources, setShowSources] = useState(false);
  /** 收藏状态：与详情页共用同一份 SQLite 数据，这里只做镜像。 */
  const [favorite, setFavorite] = useState(false);
  const [favBusy, setFavBusy] = useState(false);

  // 直播多线路：从 props 派生「线路地址数组」与「当前线路序号（钳制越界）」。
  const liveLinesArr = useMemo(() => liveLines ?? [], [liveLines]);
  const liveIdx = useMemo(() => {
    const total = liveLinesArr.length;
    if (total === 0) {
      return 0;
    }
    const i = liveLine ?? 0;
    return ((i % total) + total) % total;
  }, [liveLinesArr, liveLine]);

  // 地址解析编排：playUrl → PlayResolved（effect 体与依赖数组原样保留在 hook 内）。
  const {
    resolved,
    resolving,
    resolveError,
    timeMs,
    durationMs,
    setTimeMs,
    setDurationMs,
  } = usePlayResolution({
    siteKey,
    playUrl,
    playFrom,
    liveUa,
    vodId,
    setSwitchTip,
    setVideoError,
  });

  // 剧集列表编排：拉详情 + 按 playUrl 定位 line/episode（effect 体原样保留在 hook 内）。
  const {
    lines,
    lineIndex,
    episodeIndex,
    panelLine,
    setPanelLine,
    currentLine,
    canPrev,
    canNext,
    vod,
  } = useEpisodeList(siteKey, vodId, playUrl);

  /**
   * 历史写入需要「当前线路名 / 当前集名」，但两个值随异步剧集列表到达才确定。
   * 用 ref 取值，避免把 lines 放进历史 effect 依赖（那会重建监听并立刻写一次）。
   * 自动换线路 / 自动换源时 navigate 没有带 playFrom，currentLine.name 才可靠。
   */
  const historyLabelRef = useRef({ episodeName: "", playFrom: "" });
  historyLabelRef.current = {
    episodeName: currentLine?.episodes[episodeIndex]?.name || episodeName,
    playFrom: currentLine?.name || playFrom || "",
  };

  /** 收藏需要完整 vod（封面 / 备注）；详情还没到时用路由参数兜底，先收藏不误事。 */
  const favVod = useMemo<VodInfo | null>(() => {
    if (vod) {
      return vod;
    }
    if (!vodName.trim()) {
      return null;
    }
    return { vod_id: vodId, vod_name: vodName, vod_pic: "", vod_play_from: "", vod_play_url: "" };
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
    siteName: siteName || "",
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
    void api.favoritesPatchMeta(toVodRef(siteKey, siteName, vod)).catch(() => {
      // 补封面失败不影响收藏本身。
    });
  }, [favorite, vod, siteKey, siteName]);

  useEffect(() => {
    if (siteKey === "live") {
      setFavorite(false);
      return;
    }
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
    })();
    return () => {
      alive = false;
    };
  }, [siteKey, vodId]);

  const toggleFavorite = async () => {
    if (!favVod || favBusy) {
      return;
    }
    setFavBusy(true);
    try {
      const favRef = toVodRef(siteKey, siteName, favVod);
      const next = await api.favoritesToggle(favRef);
      setFavorite(next);
      // 加收藏时详情还没到（没有封面）：等详情回来补，别让收藏列表留空图。
      favNeedsCover.current = next && !favRef.pic;
      setSwitchTip(next ? "已加入收藏" : "已取消收藏");
    } catch (err) {
      setVideoError(`收藏操作失败：${errorMessage(err)}`);
    } finally {
      setFavBusy(false);
    }
  };

  const playable = resolved !== null && BUILTIN_KINDS.includes(resolved.kind);

  /**
   * 与详情页共用的换源候选缓存：播放页多是从详情跳转过来，缓存已就绪；
   * 从历史/收藏直接播放时这里补一次精确片名的后台检索，点换源图标不等待。
   */
  useEffect(() => {
    if (siteKey === "live" || !vodName.trim()) {
      return;
    }
    // 首帧解析优先：播放起来后再补换源候选，避免与 resolve_play 争用 sidecar。
    const timer = window.setTimeout(() => prefetchSources(vodName, sites), 5000);
    return () => window.clearTimeout(timer);
    // sites 由 App 以稳定引用传入；length 覆盖「配置还在异步加载」时从历史
    // / 收藏直接进播放页的情况，站点到达后再补一次预取判定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vodName, siteKey, sites.length]);

  useEffect(() => {
    triedSites.current = [siteKey];
    failoverStarted.current = false;
    lineSwitchStarted.current = false;
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
  const tryFailover = useCallback(async () => {
    if (failoverStarted.current) {
      return;
    }
    failoverStarted.current = true;
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
      })) as { results?: { siteKey: string; ok: boolean; data?: ResultPage }[] };

      const candidates = (agg.results ?? [])
        .filter((item) => item.ok && item.data)
        .flatMap((item) =>
          (item.data?.list ?? [])
            .filter((vod) => vod.vod_name && (vod.vod_name.includes(name) || name.includes(vod.vod_name)))
            .slice(0, 1)
            .map((vod) => ({ siteKey: item.siteKey, vod })),
        )
        .filter((item) => !triedSites.current.includes(item.siteKey));

      for (const candidate of candidates.slice(0, 8)) {
        triedSites.current.push(candidate.siteKey);
        try {
          const detail = await api.detail(candidate.siteKey, String(candidate.vod.vod_id));
          const vod = detail[0];
          if (!vod) {
            continue;
          }
          const nextLines = parsePlayLines(vod.vod_play_from, vod.vod_play_url);
          // 第一个候选常是分享页；把同片前几条线路都探一遍再决定。
          // 线路名与剧集成对保留：跨站同样要先过 playerContent。
          const ordered = nextLines
            .flatMap((line) => line.episodes.map((episode) => ({ line: line.name, episode })))
            .sort(
              (a, b) =>
                Number(b.episode.name === episodeName) - Number(a.episode.name === episodeName),
            );
          let picked: { line: string; name: string; url: string } | null = null;
          for (const { line, episode } of ordered.slice(0, 8)) {
            if (!episode.url || handledUrls.current.has(episode.url)) {
              continue;
            }
            let probe: PlayResolved;
            try {
              const target = await resolveEpisodeTarget(candidate.siteKey, line, episode.url);
              if (target.unresolvable) {
                // 网盘 token 类线路：源自己都不认，别浪费一次 resolve_play。
                continue;
              }
              probe = await api.resolvePlay({
                siteKey: candidate.siteKey,
                url: target.url,
                ua: target.ua,
                referer: target.referer,
                cookie: target.cookie,
              });
            } catch {
              continue;
            }
            if (probe.kind === "page") {
              continue;
            }
            if (!(await probePlayable(probe.proxyUrl, probe.kind))) {
              continue;
            }
            picked = { line, name: episode.name, url: episode.url };
            break;
          }
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
          handledUrls.current.add(picked.url);
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
            },
            true,
          );
          return;
        } catch {
          continue;
        }
      }
      setSwitchTip("");
      setVideoError(
        siteKey === "live"
          ? `该频道暂时无法播放，${PLAY_FAILURE_HINT}。`
          : `所有源都无法播放该影片，${PLAY_FAILURE_HINT}。`,
      );
    } catch (err) {
      setSwitchTip("");
      setVideoError(`换源失败：${errorMessage(err)}`);
    }
  }, [episodeName, navigate, vodName, siteKey, allowFailover]);

  /**
   * 真实配置里同一部剧常有多条线路：第一条是「分享页」，第二条才是直链
   * m3u8；也有线路 HTTP 探活 200 但 manifest 永远拉不出来。两条路径
   * （kind=page、HLS 长时间 stalled）都先切同片线路，找不到再跨站换源。
   */
  const tryNextLine = useCallback(async (): Promise<boolean> => {
    if (lineSwitchStarted.current) {
      return false;
    }
    lineSwitchStarted.current = true;
    handledUrls.current.add(playUrl);

    // 直播线路切换：同一频道在源里有多个可播放地址时，失败自动顺延到下一线路。
    if (siteKey === "live") {
      if (liveLinesArr.length > 1) {
        const next = (liveIdx + 1) % liveLinesArr.length;
        if (handledUrls.current.has(liveLinesArr[next])) {
          return false;
        }
        setLiveLine(liveSource ?? "", vodId, next);
        setSwitchTip(`已自动切换到线路 ${next + 1}/${liveLinesArr.length}`);
        videoRef.current = null;
        navigate(
          {
            name: "player",
            siteKey,
            vodId,
            vodName,
            episodeName,
            playUrl: liveLinesArr[next],
            liveLines: liveLinesArr,
            liveLine: next,
            liveSource,
            ua: liveUa,
          },
          true,
        );
        return true;
      }
      return false;
    }

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
          episodes = parsePlayLines(vod.vod_play_from, vod.vod_play_url).flatMap(
            (line) => line.episodes.map((episode) => ({ line: line.name, episode })),
          );
        }
      } catch {
        // 详情拿不到就直接走跨站换源。
      }
    }

    // 先试同名剧集（同一集的不同线路），再退而求其次试其它集。
    const ordered = [...episodes].sort(
      (a, b) =>
        Number(b.episode.name === episodeName) - Number(a.episode.name === episodeName),
    );
    for (const { line, episode } of ordered.slice(0, 12)) {
      if (!episode.url || handledUrls.current.has(episode.url)) {
        continue;
      }
      try {
        const target = await resolveEpisodeTarget(siteKey, line, episode.url);
        if (target.unresolvable) {
          continue;
        }
        const probe = await api.resolvePlay({
          siteKey,
          url: target.url,
          ua: target.ua,
          referer: target.referer,
          cookie: target.cookie,
        });
        if (probe.kind === "page") {
          continue;
        }
        // 别把死 CDN / 假地址当成「可播放线路」：先探一次，失败就继续找下一条。
        // 网盘解析接口会以 200 + JSON 返回「解析失败了」，只看状态码会误判
        // 成可播线路，切过去后 hls.js 报 manifestParsingError。
        if (!(await probePlayable(probe.proxyUrl, probe.kind))) {
          continue;
        }
        handledUrls.current.add(episode.url);
        setSwitchTip(`已自动切换到可播放线路「${episode.name}」`);
        videoRef.current = null;
        navigate(
          {
            name: "player",
            siteKey,
            vodId,
            vodName,
            episodeName: episode.name,
            playUrl: episode.url,
            // 切换后必须保留线路名，否则下一次解析又拿不到 playerContent。
            playFrom: line,
          },
          true,
        );
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }, [episodeName, lines, navigate, playUrl, siteKey, vodId, vodName, liveLinesArr, liveIdx, liveSource, liveUa]);

  /** 线路切换失败后的兜底：整站找同名影片。 */
  const switchOrFailover = useCallback(async () => {
    const switched = await tryNextLine();
    if (!switched) {
      await tryFailover();
    }
  }, [tryNextLine, tryFailover]);

  // tryNextLine 依赖异步加载的剧集列表；用 ref 转发，避免播放内核 effect
  // 因 lines 到达而被重新挂载（那会从头开始缓冲）。
  const switchOrFailoverRef = useRef(switchOrFailover);
  switchOrFailoverRef.current = switchOrFailover;

  useEffect(() => {
    if (resolving || resolveError || !resolved || resolved.kind !== "page") {
      return;
    }
    if (handledUrls.current.has(playUrl)) {
      return;
    }
    void switchOrFailoverRef.current();
  }, [resolved, resolving, resolveError, playUrl]);

  /**
   * 解析失败也要自动换线路。
   *
   * 之前只有「解析成分享页（kind=page）」才触发换源，像 `CO4K_…` / `qsvip-…`
   * 这种网盘 token 线路会直接在画面上留一块「无法解析播放地址」——用户要么
   * 自己回去点别的线路，要么放弃。面板里明明有 PAN1 能播，就该自动切过去。
   *
   * `handledUrls` 记住当前地址，避免「换线路 → 又回到同一条」的循环；
   * 全部线路都失败时仍会走跨站换源，最后停在错误提示上（此时提示才有意义）。
   */
  useEffect(() => {
    if (resolving || !resolveError || handledUrls.current.has(playUrl)) {
      return;
    }
    handledUrls.current.add(playUrl);
    setRecovering(true);
    setSwitchTip("当前线路无法解析，正在尝试其它线路…");
    void switchOrFailoverRef.current().finally(() => setRecovering(false));
  }, [resolving, resolveError, playUrl]);

  /**
   * 播放内核：ArtPlayer + hls.js / mpegts.js + 偏好记忆 + stalled watchdog +
   * mpv 兜底。effect 体逐字保留在 usePlayerEngine，声明顺序须先于 history
   * 与 ended 两个 effect（它们直接读内核写入的 videoRef.current）。
   */
  usePlayerEngine({
    containerRef,
    videoRef,
    lastMediaRef,
    mpvTried,
    failoverStarted,
    lineSwitchStarted,
    switchOrFailoverRef,
    liveLineRef,
    resolved,
    resolving,
    siteKey,
    vodName,
    vodId,
    onVideoMeta: setVideoMeta,
    onPlayerRoot: setPlayerRoot,
    setVideoError,
  });

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
    const write = async (force: boolean, snapshot?: { positionMs: number; durationMs?: number }) => {
      const now = Date.now();
      if (!force && now - lastWrite < 5000) {
        return;
      }
      lastWrite = now;
      knownResolution = resolutionFromVideo(video) || knownResolution;
      const item: HistoryItem = {
        siteKey,
        vodId,
        name: vodName,
        pic: historyMetaRef.current.pic,
        remarks: historyMetaRef.current.remarks,
        siteName: historyMetaRef.current.siteName,
        playUrl,
        episodeName: historyLabelRef.current.episodeName,
        playFrom: historyLabelRef.current.playFrom,
        resolution: knownResolution,
        positionMs: snapshot?.positionMs ?? Math.round(video.currentTime * 1000),
        durationMs:
          snapshot?.durationMs ??
          (Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined),
        updatedAt: now,
      };
      try {
        await api.historyUpsert(item);
      } catch {
        // 历史写入失败不应打断播放。
      }
    };

    const onPlay = () => {
      void write(true);
    };
    const onPause = () => {
      void write(true);
    };
    const onTimeUpdate = () => {
      // `timeupdate` fires ~4x/s but the progress label only shows whole
      // seconds. Skip the state write (and the whole player re-render) when
      // the second has not changed. History uses video.currentTime directly.
      const second = Math.floor(video.currentTime);
      setTimeMs((prev) => (Math.floor(prev / 1000) === second ? prev : second * 1000));
      lastMediaRef.current.positionMs = Math.round(video.currentTime * 1000);
      if (Number.isFinite(video.duration)) {
        lastMediaRef.current.durationMs = Math.round(video.duration * 1000);
      }
      void write(false);
    };
    const onMeta = () => {
      setDurationMs(Number.isFinite(video.duration) ? video.duration * 1000 : 0);
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
  }, [resolved, siteKey, vodId, vodName, playUrl, setTimeMs, setDurationMs]);

  /**
   * 看完一集自动接下一集：连看时不必每集回来点按钮。
   *
   * `ended` 只在当前 <video> 上生效，而换集会重建播放内核，所以依赖里带上
   * `resolved`；直播与最后一集不接。
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || siteKey === "live") {
      return;
    }
    const onEnded = () => {
      if (!canNext || !currentLine) {
        return;
      }
      const next = currentLine.episodes[episodeIndex + 1];
      // navigate 会重建本页，[siteKey, playUrl] effect 会清空 switchTip；提示必须
      // 像手动换源那样经 sessionStorage 带过去一次，否则用户永远看不到。
      window.sessionStorage.setItem("luma:autoSwitch", `已自动播放下一集：${next?.name ?? ""}`);
      const target = lines[lineIndex];
      if (!target) {
        return;
      }
      const episode = target.episodes[episodeIndex + 1];
      if (!episode) {
        return;
      }
      log.info("auto next episode", {
        siteKey,
        vodId,
        from: episodeIndex,
        to: episodeIndex + 1,
      });
      videoRef.current = null;
      navigate(
        {
          name: "player",
          siteKey,
          vodId,
          vodName,
          playUrl: episode.url,
          episodeName: episode.name,
          playFrom: target.name,
        },
        true,
      );
    };
    video.addEventListener("ended", onEnded);
    return () => video.removeEventListener("ended", onEnded);
    // navigate / lines 随集数变化，但真正需要重挂的只有播放内核与当前集。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, canNext, lineIndex, episodeIndex, siteKey, vodId, vodName]);

  /** 选集面板里点任意线路 / 任意一集，直接替换当前播放页。 */
  const goToEpisode = (targetLine: number, index: number) => {
    const target = lines[targetLine];
    if (!target || index < 0 || index >= target.episodes.length) {
      return;
    }
    const episode = target.episodes[index];
    videoRef.current = null;
    navigate(
      {
        name: "player",
        siteKey,
        vodId,
        vodName,
        playUrl: episode.url,
        episodeName: episode.name,
        playFrom: target.name,
      },
      true,
    );
  };

  const goEpisode = (delta: number) => {
    if (!currentLine) {
      return;
    }
    goToEpisode(lineIndex, episodeIndex + delta);
  };

  /**
   * 手动换源：用户选定站点后取该站详情，尽量续播同一集（同名 / 同集号 /
   * 同序号），不探活也不抢答——选哪个源由用户决定，失败仍走原有兜底链路。
   */
  const pickSource = async (option: SourceOption) => {
    setShowSources(false);
    const list = await api.detail(option.siteKey, option.vodId);
    const nextLines = list?.[0]
      ? parsePlayLines(list[0].vod_play_from, list[0].vod_play_url)
      : [];
    const match = pickMatchingEpisode(nextLines, {
      name: episodeName,
      index: episodeIndex,
    });
    if (!match) {
      throw "该源没有可播放剧集，请换一个片源";
    }
    // 换源会重建页面，提示沿用自动换源的通道带过去一次。
    log.info("manual source switch", {
      from: siteKey,
      to: option.siteKey,
      vodId: option.vodId,
      episode: episodeName,
    });
    window.sessionStorage.setItem(
      "luma:autoSwitch",
      `已手动切换到「${option.siteName}」`,
    );
    videoRef.current = null;
    navigate(
      {
        name: "player",
        siteKey: option.siteKey,
        vodId: option.vodId,
        vodName: option.vodName || vodName,
        playUrl: match.episode.url,
        episodeName: match.episode.name,
        playFrom: match.line.name,
      },
      true,
    );
  };

  const playExternal = async () => {
    // 开关关闭时按钮不会渲染，这里再兜一层：防止快捷键 / 旧缓存里的调用
    // 绕过 UI 直接拉起系统播放器。
    if (!EXTERNAL_PLAY_ENABLED) {
      return;
    }
    const target = resolved?.url || playUrl;
    try {
      await api.openExternal(target);
    } catch (err) {
      setVideoError(`打开外部播放器失败：${errorMessage(err)}`);
    }
  };

  /** 当前集名：剧集列表到达后用列表里的名字，否则用路由参数。 */
  const nowEpisode = currentLine?.episodes[episodeIndex]?.name || episodeName;

  const progressLabel = useMemo(
    () => `${formatDuration(timeMs)} / ${durationMs > 0 ? formatDuration(durationMs) : "--:--"}`,
    [timeMs, durationMs],
  );

  // 直播手动切换线路：记住选择并替换栈顶，整页干净重载到新线路。
  const pickLiveLine = useCallback(
    (index: number) => {
      const total = liveLinesArr.length;
      if (total <= 1) {
        return;
      }
      const idx = ((index % total) + total) % total;
      if (idx === liveIdx) {
        return;
      }
      setLiveLine(liveSource ?? "", vodId, idx);
      videoRef.current = null;
      navigate(
        {
          name: "player",
          siteKey,
          vodId,
          vodName,
          episodeName,
          playUrl: liveLinesArr[idx],
          liveLines: liveLinesArr,
          liveLine: idx,
          liveSource,
          ua: liveUa,
        },
        true,
      );
    },
    [liveLinesArr, liveIdx, liveSource, vodId, vodName, episodeName, siteKey, liveUa, navigate],
  );

  // 线路按钮只服务直播多线路；单线路不给控制栏添一个永远只有一项的菜单。
  liveLineRef.current =
    siteKey === "live" && liveLinesArr.length > 1
      ? { lines: liveLinesArr, index: liveIdx, onPick: pickLiveLine }
      : null;

  return (
    <section className="page page--player">
      <PlayerHeader
        vodName={vodName}
        episodeName={episodeName}
        progressLabel={progressLabel}
        onBack={onBack}
        favorite={siteKey === "live" ? null : favorite}
        favBusy={favBusy}
        onToggleFavorite={() => void toggleFavorite()}
      />

      {switchTip ? <p className="tip">{switchTip}</p> : null}
      {videoError && !recovering ? <ErrorBar message={videoError} /> : null}
      {resolveError && !recovering ? (
        <ErrorBar message={`播放地址解析失败：${resolveError}`} />
      ) : null}

      <PlayerStage
        resolving={resolving}
        playable={playable}
        recovering={recovering}
        resolveError={resolveError}
        containerRef={containerRef}
        nav={
          siteKey === "live" || !currentLine
            ? null
            : {
                canPrev,
                canNext,
                onPrev: () => goEpisode(-1),
                onNext: () => goEpisode(1),
              }
        }
      />

      {/* 分辨率角标：真正渲染在 ArtPlayer 的全屏节点里（portal），这里只提供数据。 */}
      <PlayerResolution
        host={playerRoot}
        label={resolutionBadge(videoMeta)}
        detail={resolutionDetail(videoMeta.width, videoMeta.height)}
      />

      {/* 影片信息卡：片名/年份/简介 + 换源，紧跟在播放器下方。
          外部播放按钮由 EXTERNAL_PLAY_ENABLED 控制，关闭时整个入口不渲染。 */}
      <PlayerAbout
        vod={vod}
        fallbackName={vodName}
        siteKey={siteKey}
        siteName={siteName}
        lineName={currentLine?.name}
        episodeLabel={nowEpisode || undefined}
        onSwitchSource={siteKey === "live" ? undefined : () => setShowSources(true)}
        onPlayExternal={EXTERNAL_PLAY_ENABLED ? () => void playExternal() : undefined}
      />

      {/* 直播线路切换在播放器控制栏里（PlayerStage → ArtPlayer controls），
          不再在下方单独占一行 chip；节目单紧跟在信息卡下面。 */}
      {/* 直播态节目单：按频道名匹配当前频道的当日节目并高亮正在播放项。 */}
      {siteKey === "live" ? (
        <LiveEpgPanel
          channelName={vodName}
          reloadKey={`${vodName}|${liveIdx}|${playUrl}`}
        />
      ) : null}

      {/* 选集常驻在信息卡下面：不再需要「选集」按钮展开一层。 */}
      {siteKey !== "live" && lines.length > 0 ? (
        <EpisodePanel
          lines={lines}
          panelLine={panelLine}
          lineIndex={lineIndex}
          episodeIndex={episodeIndex}
          setPanelLine={setPanelLine}
          goToEpisode={goToEpisode}
        />
      ) : null}

      {showSources ? (
        <SourcePicker
          title={vodName}
          currentSiteKey={siteKey}
          currentSiteName={siteName}
          sites={sites}
          notice={allowFailover ? undefined : "当前源禁止自动换源，手动切换仍由你决定。"}
          onPick={pickSource}
          onClose={() => setShowSources(false)}
        />
      ) : null}
    </section>
  );
}
