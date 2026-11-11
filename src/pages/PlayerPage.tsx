import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Artplayer from "artplayer";
import artplayerPluginHlsControl from "artplayer-plugin-hls-control";
import Hls from "hls.js";
import type { Navigate } from "../App";
import ErrorBar from "../components/ErrorBar";
import SourcePicker from "../components/SourcePicker";
import Spinner from "../components/Spinner";
import { formatDuration, parsePlayLines } from "../lib/format";
import type { PlayLine } from "../lib/format";
import { countEpisodes, pickMatchingEpisode } from "../lib/sources";
import { prefetchSources } from "../lib/sourceCache";
import { log } from "../lib/logger";
import type { SourceOption } from "../lib/sources";
import { api, errorMessage } from "../lib/invoke";
import type { HistoryItem, PlayResolved, ResultPage, Site } from "../types/tvbox";

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
  /** 站点 `changeable: 0` 时禁止跨站自动换源；缺省允许。手动换源不受限。 */
  allowFailover?: boolean;
  /** 手动换源需要站点清单做名称映射与可用性过滤。 */
  sites: Site[];
  siteName?: string;
  navigate: Navigate;
  onBack: () => void;
}

const BUILTIN_KINDS = ["hls", "flv", "file"];

/**
 * mpegts.js 的最小类型面。
 *
 * 它的 d.ts 用 `export default Mpegts` 导出一个命名空间，`import("mpegts.js")`
 * 的类型查询取不到 default（TS2694），而运行时的 CJS 互操作又确实挂在
 * `default` 上。与其和第三方声明文件较劲，这里只声明真正用到的四个成员。
 */
interface FlvPlayerLike {
  attachMediaElement(element: HTMLMediaElement): void;
  load(): void;
  destroy(): void;
  on(event: string, handler: (type: string, detail: string) => void): void;
}

interface MpegtsLike {
  isSupported(): boolean;
  createPlayer(
    config: { type: string; url: string; isLive?: boolean },
    options?: Record<string, unknown>,
  ): FlvPlayerLike;
  Events: { ERROR: string };
}

/** 播放页：解析地址 → 内置播放 → 记录历史；必要时外部播放。 */
export default function PlayerPage({
  siteKey,
  vodId,
  vodName,
  episodeName,
  playUrl,
  playFrom,
  liveUa,
  allowFailover = true,
  sites,
  siteName,
  navigate,
  onBack,
}: PlayerPageProps) {
  /** ArtPlayer 挂载点；实例会在这个容器里生成真正的 <video>。 */
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** ArtPlayer 托管的原生 <video>，换源、兜底、历史逻辑仍基于它。 */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** 卸载时 ArtPlayer 会清掉 src，进度必须独立留一份快照。 */
  const lastMediaRef = useRef<{ positionMs: number; durationMs?: number }>({ positionMs: 0 });

  const [resolved, setResolved] = useState<PlayResolved | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState("");
  const [videoError, setVideoError] = useState("");
  const [timeMs, setTimeMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);

  const [switchTip, setSwitchTip] = useState("");
  const triedSites = useRef<string[]>([]);
  const failoverStarted = useRef(false);
  /** 已经自动处理过的地址，避免切线路 / 换源之间来回跳转。 */
  const handledUrls = useRef<Set<string>>(new Set());
  /** T-30：解码失败只自动转 mpv 一次，避免用户手动关掉后被反复拉起。 */
  const mpvTried = useRef(false);
  /** 同一轮播放只允许一次「找下一条线路」，防止多个失败信号并发触发。 */
  const lineSwitchStarted = useRef(false);

  const [lines, setLines] = useState<PlayLine[]>([]);
  const [lineIndex, setLineIndex] = useState(0);
  const [episodeIndex, setEpisodeIndex] = useState(0);
  /** 播放页内的选集面板与手动换源弹层。 */
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelLine, setPanelLine] = useState(0);
  const [showSources, setShowSources] = useState(false);

  /**
   * 与详情页共用的换源候选缓存：播放页多是从详情跳转过来，缓存已就绪；
   * 从历史/收藏直接播放时这里补一次精确片名的后台检索，点「⇄ 换源」不等待。
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
    let alive = true;
    const run = async () => {
      setResolving(true);
      setResolveError("");
      setVideoError("");
      setResolved(null);
      setTimeMs(0);
      setDurationMs(0);
      try {
        // TVBox 链路：详情里的 playUrl 常常只是线路 id 或自定义 scheme
        // （weiguan://、PAN1-…、6105_0_1），必须让 spider 的 playerContent
        // 解析出真实直链再交给本地代理。CMS 未实现该方法时直接回退。
        let targetUrl = playUrl;
        // 直播没有 playerContent 可问，UA 只能来自 lives[].ua。
        let ua: string | undefined = liveUa;
        let referer: string | undefined;
        let cookie: string | undefined;
        if (playFrom) {
          try {
            const played = (await api.spiderInvoke({
              siteKey,
              method: "playerContent",
              args: [playFrom, playUrl, []],
              timeoutMs: 15_000,
            })) as {
              playUrl?: string;
              url?: string;
              parse?: number;
              jx?: number;
              header?: Record<string, string>;
            } | null;
            const candidate = String(played?.playUrl || played?.url || "");
            const parseFlag = Number(played?.parse ?? 0);
            const jxFlag = Number(played?.jx ?? 0);
            const header = played?.header ?? {};
            ua = header["User-Agent"] || header["user-agent"];
            referer = header["Referer"] || header["referer"];
            cookie = header["Cookie"] || header["cookie"];

            if (/^https?:\/\//i.test(candidate)) {
              // `127.0.0.1:9978/proxy?do=py…` 由宿主实现（spider.proxy 转发），
              // `resolve_play` 会识别本机代理地址并原样透传。
              const isLocalProxy =
                /^https?:\/\/127\.0\.0\.1:\d+\/(proxy|proxy2)\b/i.test(candidate);
              if (isLocalProxy) {
                targetUrl = candidate;
              } else if (parseFlag !== 0 || jxFlag !== 0) {
                // TVBox 语义：parse=1 / jx=1 表示该地址还要过 parses[] 解析池
                // （type 0 嗅探 / type 1 JSON 接口 / type 4 并行竞速）。
                try {
                  const hit = await api.parseResolve({
                    siteKey,
                    url: candidate,
                    flag: playFrom,
                    headers: header,
                  });
                  if (hit?.url) {
                    targetUrl = hit.url;
                    for (const [name, value] of hit.headers ?? []) {
                      const lower = name.toLowerCase();
                      if (lower === "user-agent") {
                        ua = value;
                      } else if (lower === "referer") {
                        referer = value;
                      } else if (lower === "cookie") {
                        cookie = value;
                      }
                    }
                    setSwitchTip(`解析来自「${hit.parser}」`);
                  }
                } catch {
                  // 解析池全失败：保留原地址，由 resolve_play 的嗅探兜底。
                  targetUrl = candidate;
                }
              } else {
                targetUrl = candidate;
              }
            }
          } catch {
            // CMS / 未实现 playerContent 的源：沿用原始地址。
          }
        }
        const result = await api.resolvePlay({ siteKey, url: targetUrl, ua, referer, cookie });
        if (alive) {
          setResolved(result);
        }
      } catch (err) {
        if (alive) {
          setResolveError(errorMessage(err));
          log.warn("resolve failed", {
            siteKey,
            vodId,
            message: errorMessage(err),
          });
        }
      } finally {
        if (alive) {
          setResolving(false);
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [siteKey, playUrl, playFrom, liveUa]);

  // 拉详情只为拿剧集列表做上/下集，失败不影响当前播放。
  useEffect(() => {
    // 直播没有剧集概念，去拿 detailContent 只会多一次必败请求。
    if (siteKey === "live") {
      setLines([]);
      return;
    }
    let alive = true;
    const run = async () => {
      try {
        const list = await api.detail(siteKey, vodId);
        if (!alive) {
          return;
        }
        const first = list && list.length > 0 ? list[0] : null;
        setLines(first ? parsePlayLines(first.vod_play_from, first.vod_play_url) : []);
      } catch {
        if (alive) {
          setLines([]);
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [siteKey, vodId]);

  useEffect(() => {
    for (let line = 0; line < lines.length; line += 1) {
      const index = lines[line].episodes.findIndex((item) => item.url === playUrl);
      if (index >= 0) {
        setLineIndex(line);
        setPanelLine(line);
        setEpisodeIndex(index);
        return;
      }
    }
    setLineIndex(0);
    setPanelLine(0);
    setEpisodeIndex(0);
  }, [lines, playUrl]);

  const playable = resolved !== null && BUILTIN_KINDS.includes(resolved.kind);

  useEffect(() => {
    triedSites.current = [siteKey];
    failoverStarted.current = false;
    lineSwitchStarted.current = false;
    // 换源跳转会重建本页，提示通过 sessionStorage 带过来一次。
    const carried = window.sessionStorage.getItem("luma:autoSwitch");
    if (carried) {
      window.sessionStorage.removeItem("luma:autoSwitch");
      setSwitchTip(carried);
    } else {
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
      setVideoError("该源不允许换源，可尝试外部播放。");
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
          const ordered = [...nextLines.flatMap((line) => line.episodes)].sort(
            (a, b) => Number(b.name === episodeName) - Number(a.name === episodeName),
          );
          let picked: { name: string; url: string } | null = null;
          for (const item of ordered.slice(0, 8)) {
            if (!item.url || handledUrls.current.has(item.url)) {
              continue;
            }
            let probe: PlayResolved;
            try {
              probe = await api.resolvePlay({ siteKey: candidate.siteKey, url: item.url });
            } catch {
              continue;
            }
            if (probe.kind === "page") {
              continue;
            }
            const controller = new AbortController();
            const timer = window.setTimeout(() => controller.abort(), 5000);
            let reachable = false;
            try {
              const response = await fetch(probe.proxyUrl, {
                headers: probe.kind === "hls" ? undefined : { Range: "bytes=0-0" },
                signal: controller.signal,
              });
              reachable = response.ok || response.status === 405 || response.status === 416;
            } catch {
              reachable = false;
            } finally {
              window.clearTimeout(timer);
            }
            if (reachable) {
              picked = item;
              break;
            }
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
          navigate(
            {
              name: "player",
              siteKey: candidate.siteKey,
              vodId: String(candidate.vod.vod_id),
              vodName: vod.vod_name || candidate.vod.vod_name,
              episodeName: picked.name,
              playUrl: picked.url,
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
          ? "该频道暂时无法播放，可尝试外部播放。"
          : "所有源都无法播放该影片，可尝试外部播放。",
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

    // 直播没有剧集概念，detailContent("live", ...) 只会多一次必败 IPC。
    if (siteKey === "live") {
      return false;
    }

    let episodes = lines.flatMap((line) => line.episodes);
    if (episodes.length === 0) {
      try {
        const detail = await api.detail(siteKey, vodId);
        const vod = detail[0];
        if (vod) {
          episodes = parsePlayLines(vod.vod_play_from, vod.vod_play_url).flatMap(
            (line) => line.episodes,
          );
        }
      } catch {
        // 详情拿不到就直接走跨站换源。
      }
    }

    // 先试同名剧集（同一集的不同线路），再退而求其次试其它集。
    const ordered = [...episodes].sort(
      (a, b) => Number(b.name === episodeName) - Number(a.name === episodeName),
    );
    for (const episode of ordered.slice(0, 12)) {
      if (!episode.url || handledUrls.current.has(episode.url)) {
        continue;
      }
      try {
        const probe = await api.resolvePlay({ siteKey, url: episode.url });
        if (probe.kind === "page") {
          continue;
        }
        // 别把死 CDN 当成「可播放线路」：先探一次，失败就继续找下一条。
        // m3u8 manifest 很小可直接 GET；mp4/flv 用 Range 避免整片下载。
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 5000);
        let reachable = false;
        try {
          const response = await fetch(probe.proxyUrl, {
            headers: probe.kind === "hls" ? undefined : { Range: "bytes=0-0" },
            signal: controller.signal,
          });
          reachable = response.ok || response.status === 405 || response.status === 416;
        } catch {
          reachable = false;
        } finally {
          window.clearTimeout(timer);
        }
        if (!reachable) {
          continue;
        }
        handledUrls.current.add(episode.url);
        setSwitchTip(`已自动切换到可播放线路「${episode.name}」`);
        navigate(
          {
            name: "player",
            siteKey,
            vodId,
            vodName,
            episodeName: episode.name,
            playUrl: episode.url,
          },
          true,
        );
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }, [episodeName, lines, navigate, playUrl, siteKey, vodId, vodName]);

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
   * 挂载 / 销毁播放内核：ArtPlayer 负责控件与交互，解码仍交给现有 hls.js。
   * 反代地址（127.0.0.1:9978/proxy?…）没有扩展名，必须显式传 type，
   * 否则 customType 不命中，m3u8 会被直接塞给 <video> 而失败。
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !resolved) {
      return;
    }

    mpvTried.current = false;
    lastMediaRef.current = { positionMs: 0 };
    const art = new Artplayer({
      container,
      url: resolved.proxyUrl,
      type: resolved.kind === "hls" ? "m3u8" : resolved.kind,
      lang: "zh-cn",
      theme: "#e50914",
      volume: 0.8,
      isLive: siteKey === "live",
      autoPlayback: false,
      screenshot: false,
      hotkey: true,
      playbackRate: true,
      aspectRatio: true,
      setting: true,
      pip: true,
      fullscreen: true,
      fullscreenWeb: true,
      miniProgressBar: true,
      mutex: true,
      moreVideoAttr: { playsInline: true },
      plugins:
        resolved.kind === "hls"
          ? [
              artplayerPluginHlsControl({
                quality: {
                  control: true,
                  setting: true,
                  title: "清晰度",
                  auto: "自动",
                  // 多数 TVBox 源是单码率且不带 RESOLUTION，插件默认会显示
                  // "0P"；无分辨率时退回码率 / 片源自定义名 / 原画。
                  getName: (level) => {
                    const item = level as { name?: string; height?: number; bitrate?: number };
                    if (item.height && item.height > 0) {
                      return `${item.height}P`;
                    }
                    if (item.bitrate && item.bitrate > 0) {
                      return `${Math.round(item.bitrate / 1000)}kbps`;
                    }
                    return item.name || "原画";
                  },
                },
                audio: { control: false, setting: true, title: "音轨", auto: "自动" },
              }),
            ]
          : [],
      customType: {
        m3u8: (video, url, instance) => {
          // WebView2 的 canPlayType 会对 mpegurl 返回 "maybe"，但真正把
          // m3u8 塞给 <video> 会以 MEDIA_ERR_SRC_NOT_SUPPORTED 失败。
          if (!Hls.isSupported()) {
            if (video.canPlayType("application/vnd.apple.mpegurl")) {
              video.src = url;
            } else {
              setVideoError("当前环境不支持 HLS 内置播放，请使用外部播放。");
            }
            return;
          }
          const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
          hls.loadSource(url);
          hls.attachMedia(video);
          // hls-control 插件约定从 art.hls 读 levels / currentLevel。
          instance.hls = hls;
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            // 插件默认只在 ready / restart 读 levels；manifest 解析完再刷一次，
            // 避免首次播放时清晰度列表还是空的。
            const control = instance.plugins.artplayerPluginHlsControl as
              | { update?: () => void }
              | undefined;
            control?.update?.();
            void video.play().catch(() => {
              // 自动播放被拦截时保留控件，用户点一下即可。
            });
          });
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!data.fatal) {
              return;
            }
            const reason = data.details ? String(data.details) : "未知错误";
            setVideoError(`HLS 播放失败：${reason}`);
            void switchOrFailoverRef.current();
          });
          instance.on("destroy", () => hls.destroy());
        },
        flv: (video, url, instance) => {
          // WebView2 没有内置 FLV 解码（<video> 直接吃 flv 会 SRC_NOT_SUPPORTED），
          // 必须用 mpegts.js 走 MSE 分包。按需 import：只有真播 FLV 时才加载，
          // 不拖累 HLS / 直链的播放页体积。
          let player: FlvPlayerLike | null = null;
          let disposed = false;
          instance.on("destroy", () => {
            disposed = true;
            player?.destroy();
            player = null;
          });
          void (async () => {
            try {
              const mod = (await import("mpegts.js")) as unknown as {
                default?: MpegtsLike;
              } & MpegtsLike;
              // mpegts.js 的 d.ts 用 `export default Mpegts` 导出一个命名空间，
              // `import("mpegts.js").default` 取不到类型；运行时 CJS 互操作后
              // default 才是本体，这里两个都兜一下。
              const mpegts = mod.default ?? mod;
              if (disposed) {
                return;
              }
              if (!mpegts.isSupported()) {
                setVideoError("当前环境不支持 FLV 内置播放，已改用外部播放。");
                return;
              }
              player = mpegts.createPlayer(
                { type: "flv", url, isLive: siteKey === "live" },
                {
                  enableWorker: true,
                  // 直播要低延迟；点播留一点缓冲避免卡顿。
                  enableStashBuffer: siteKey !== "live",
                  lazyLoad: siteKey !== "live",
                  stashInitialSize: 128,
                },
              );
              player.attachMediaElement(video);
              player.load();
              player.on(mpegts.Events.ERROR, (_type: string, detail: string) => {
                setVideoError(`FLV 播放失败：${detail}`);
                void switchOrFailoverRef.current();
              });
              void video.play().catch(() => {
                // 自动播放被拦截时保留控件，用户点一下即可。
              });
            } catch (err) {
              setVideoError(`FLV 解码组件加载失败：${errorMessage(err)}`);
            }
          })();
        },
      },
    });

    const video = art.video;
    videoRef.current = video;

    const onError = () => {
      const mediaError = video.error;
      // 3 = MEDIA_ERR_DECODE, 4 = MEDIA_ERR_SRC_NOT_SUPPORTED. WebView2 常见于
      // HEVC：换源也救不了同一编码，直接交给随包 mpv（规格 T-30 自动兜底）。
      if (mediaError && (mediaError.code === 3 || mediaError.code === 4) && !mpvTried.current) {
        mpvTried.current = true;
        log.warn("mpv fallback", { siteKey, vodId, mediaCode: mediaError.code });
        setVideoError("浏览器无法解码该视频，已自动交给 mpv 播放…");
        void api
          .mpvPlay(resolved.url, vodName, resolved.headers)
          .catch((err) => {
            setVideoError(`mpv 启动失败：${errorMessage(err)}`);
            void switchOrFailoverRef.current();
          });
        return;
      }
      setVideoError("播放器加载失败，可尝试外部播放。");
      void switchOrFailoverRef.current();
    };
    video.addEventListener("error", onError);

    // 死 CDN 会让 hls.js 无限重试却不触发 fatal，画面永远停在 00:00。
    // 12 秒仍没拿到首帧就视作线路不可用，主动切线路 / 换源。
    const stallTimer = window.setTimeout(() => {
      if (!BUILTIN_KINDS.includes(resolved.kind)) {
        return;
      }
      if (video.readyState >= 2 || failoverStarted.current || lineSwitchStarted.current) {
        return;
      }
      setVideoError("当前线路长时间无法加载，正在尝试其它线路…");
      void switchOrFailoverRef.current();
    }, 12_000);

    return () => {
      window.clearTimeout(stallTimer);
      video.removeEventListener("error", onError);
      // 先置空引用，避免 destroy 过程中的 video:error 再触发换源。
      videoRef.current = null;
      art.destroy();
    };
  }, [resolved, siteKey, vodName]);

  // 播放进度 → 历史记录（5 秒节流，播放/暂停立即写）。
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !resolved) {
      return;
    }

    let lastWrite = 0;
    /** 卸载时 ArtPlayer 已清掉 src，最后一次写入用快照，不重读 currentTime。 */
    const write = async (force: boolean, snapshot?: { positionMs: number; durationMs?: number }) => {
      const now = Date.now();
      if (!force && now - lastWrite < 5000) {
        return;
      }
      lastWrite = now;
      const item: HistoryItem = {
        siteKey,
        vodId,
        name: vodName,
        playUrl,
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
  }, [resolved, siteKey, vodId, vodName, playUrl]);

  const currentLine = lines[lineIndex] ?? null;
  const canPrev = currentLine !== null && episodeIndex > 0;
  const canNext = currentLine !== null && episodeIndex < currentLine.episodes.length - 1;

  /** 选集面板里点任意线路 / 任意一集，直接替换当前播放页。 */
  const goToEpisode = (targetLine: number, index: number) => {
    const target = lines[targetLine];
    if (!target || index < 0 || index >= target.episodes.length) {
      return;
    }
    const episode = target.episodes[index];
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
    const target = resolved?.url || playUrl;
    try {
      await api.openExternal(target);
    } catch (err) {
      setVideoError(`打开外部播放器失败：${errorMessage(err)}`);
    }
  };

  const progressLabel = useMemo(
    () => `${formatDuration(timeMs)} / ${durationMs > 0 ? formatDuration(durationMs) : "--:--"}`,
    [timeMs, durationMs],
  );

  return (
    <section className="page page--player">
      <header className="page-head">
        <div className="page-head__main">
          <button type="button" className="btn btn--ghost" onClick={onBack}>
            ← 返回详情
          </button>
          <h1 className="page-title">
            {vodName || "播放"}
            <span className="page-title__sub">{episodeName}</span>
          </h1>
        </div>
        <div className="player-head__meta">
          <span className="detail-source" title={siteKey}>
            当前源：{siteName || siteKey}
          </span>
          <span className="page-meta">{progressLabel}</span>
        </div>
      </header>

      {switchTip ? <p className="tip">{switchTip}</p> : null}
      {videoError ? <ErrorBar message={videoError} /> : null}
      {resolveError ? <ErrorBar message={`播放地址解析失败：${resolveError}`} /> : null}

      <div className="player-stage">
        {resolving ? <Spinner label="正在解析播放地址…" /> : null}

        {!resolving && playable ? <div ref={containerRef} className="player-art" /> : null}

        {!resolving && !playable ? (
          <div className="player-fallback">
            <p className="player-fallback__title">
              {resolveError ? "无法解析播放地址" : "该地址需要在外部播放器中打开"}
            </p>
            <p className="player-fallback__desc">
              内置播放器只支持 HLS / FLV / 直链媒体，其余格式请交给系统播放器。
            </p>
          </div>
        ) : null}
      </div>

      <div className="player-bar">
        {siteKey === "live" ? null : (
          <>
            <button
              type="button"
              className="btn"
              onClick={() => goEpisode(-1)}
              disabled={!canPrev}
            >
              上一集
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => goEpisode(1)}
              disabled={!canNext}
            >
              下一集
            </button>
          </>
        )}
        {siteKey === "live" ? (
          <span className="player-bar__info">直播 · {vodName}</span>
        ) : currentLine ? (
          <span className="player-bar__info">
            {currentLine.name} · 第 {episodeIndex + 1} / {currentLine.episodes.length} 集
          </span>
        ) : (
          <span className="player-bar__info">未获取到剧集列表</span>
        )}
        {siteKey === "live" ? null : (
          <button
            type="button"
            className="btn"
            onClick={() => setPanelOpen((value) => !value)}
            disabled={lines.length === 0}
          >
            {panelOpen ? "收起选集" : "选集"}
          </button>
        )}
        {siteKey === "live" ? null : (
          <button type="button" className="btn" onClick={() => setShowSources(true)}>
            ⇄ 换源
          </button>
        )}
        <button type="button" className="btn btn--primary" onClick={() => void playExternal()}>
          外部播放
        </button>
      </div>

      {/* 选集面板：线路切换 + 任意一集直达，替代只能上一集/下一集的旧交互。 */}
      {panelOpen && lines.length > 0 ? (
        <div className="player-episodes">
          <div className="section-head">
            <h2 className="section-title">选集 · 线路</h2>
            <span className="page-meta">
              共 {lines.length} 条线路 · {countEpisodes(lines)} 集
            </span>
          </div>
          <div className="chip-row">
            {lines.map((item, index) => (
              <button
                key={`${item.name}-${index}`}
                type="button"
                className={index === panelLine ? "chip is-active" : "chip"}
                onClick={() => setPanelLine(index)}
                title={`${item.episodes.length} 集`}
              >
                {item.name}（{item.episodes.length}）
              </button>
            ))}
          </div>
          <div className="episode-grid">
            {(lines[panelLine]?.episodes ?? []).map((episode, index) => {
              const active = panelLine === lineIndex && index === episodeIndex;
              return (
                <button
                  key={`${episode.url}-${index}`}
                  type="button"
                  className={active ? "episode is-active" : "episode"}
                  onClick={() => goToEpisode(panelLine, index)}
                  title={episode.name}
                >
                  {episode.name}
                </button>
              );
            })}
          </div>
        </div>
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
