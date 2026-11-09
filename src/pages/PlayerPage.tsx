import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import type { Navigate } from "../App";
import ErrorBar from "../components/ErrorBar";
import Spinner from "../components/Spinner";
import { formatDuration, parsePlayLines } from "../lib/format";
import type { PlayLine } from "../lib/format";
import { api, toAppError } from "../lib/invoke";
import type { HistoryItem, PlayResolved, ResultPage } from "../types/tvbox";

interface PlayerPageProps {
  siteKey: string;
  vodId: string;
  vodName: string;
  episodeName: string;
  playUrl: string;
  navigate: Navigate;
  onBack: () => void;
}

const BUILTIN_KINDS = ["hls", "flv", "file"];

/** 播放页：解析地址 → 内置播放 → 记录历史；必要时外部播放。 */
export default function PlayerPage({
  siteKey,
  vodId,
  vodName,
  episodeName,
  playUrl,
  navigate,
  onBack,
}: PlayerPageProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

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
  /** 同一轮播放只允许一次「找下一条线路」，防止多个失败信号并发触发。 */
  const lineSwitchStarted = useRef(false);

  const [lines, setLines] = useState<PlayLine[]>([]);
  const [lineIndex, setLineIndex] = useState(0);
  const [episodeIndex, setEpisodeIndex] = useState(0);

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
        const result = await api.resolvePlay({ siteKey, url: playUrl });
        if (alive) {
          setResolved(result);
        }
      } catch (err) {
        if (alive) {
          setResolveError(toAppError(err).message);
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
  }, [siteKey, playUrl]);

  // 拉详情只为拿剧集列表做上/下集，失败不影响当前播放。
  useEffect(() => {
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
        setEpisodeIndex(index);
        return;
      }
    }
    setLineIndex(0);
    setEpisodeIndex(0);
  }, [lines, playUrl]);

  const playable = resolved !== null && BUILTIN_KINDS.includes(resolved.kind);

  useEffect(() => {
    triedSites.current = [siteKey];
    failoverStarted.current = false;
    lineSwitchStarted.current = false;
    // 换源跳转会重建本页，提示通过 sessionStorage 带过来一次。
    const carried = window.sessionStorage.getItem("tvbox:autoSwitch");
    if (carried) {
      window.sessionStorage.removeItem("tvbox:autoSwitch");
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
          window.sessionStorage.setItem("tvbox:autoSwitch", tip);
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
      setVideoError("所有源都无法播放该影片，可尝试外部播放。");
    } catch (err) {
      setSwitchTip("");
      setVideoError(`换源失败：${toAppError(err).message}`);
    }
  }, [episodeName, navigate, vodName]);

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
    void switchOrFailover();
  }, [resolved, resolving, resolveError, playUrl, switchOrFailover]);

  // 挂载 / 销毁播放内核。
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !resolved) {
      return;
    }
    const source = resolved.proxyUrl;
    const onError = () => {
      setVideoError("播放器加载失败，可尝试外部播放。");
      void switchOrFailoverRef.current();
    };
    video.addEventListener("error", onError);

    let hls: Hls | null = null;
    let stallTimer: number | undefined;

    if (resolved.kind === "hls") {
      // Prefer hls.js: WebView2 的 canPlayType 会对 mpegurl 返回 "maybe"，但真正
      // 把 m3u8 塞给 <video> 会以 MEDIA_ERR_SRC_NOT_SUPPORTED 失败。
      if (Hls.isSupported()) {
        hls = new Hls({ enableWorker: true, lowLatencyMode: true });
        hls.loadSource(source);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          void video.play().catch(() => {
            // 自动播放被拦截时保留控件，用户点一下即可。
          });
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            const reason = data.details ? String(data.details) : "未知错误";
            setVideoError(`HLS 播放失败：${reason}`);
            void switchOrFailoverRef.current();
          }
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = source;
      } else {
        setVideoError("当前环境不支持 HLS 内置播放，请使用外部播放。");
      }
    } else if (resolved.kind === "flv" || resolved.kind === "file") {
      video.src = source;
    } else {
      setVideoError("该地址需要外部播放器。");
    }

    // 死 CDN 会让 hls.js 无限重试却不触发 fatal，画面永远停在 00:00。
    // 12 秒仍没拿到首帧就视作线路不可用，主动切线路 / 换源。
    if (BUILTIN_KINDS.includes(resolved.kind)) {
      stallTimer = window.setTimeout(() => {
        if (video.readyState >= 2 || failoverStarted.current || lineSwitchStarted.current) {
          return;
        }
        setVideoError("当前线路长时间无法加载，正在尝试其它线路…");
        void switchOrFailoverRef.current();
      }, 12_000);
    }

    return () => {
      video.removeEventListener("error", onError);
      if (stallTimer !== undefined) {
        window.clearTimeout(stallTimer);
      }
      video.pause();
      if (hls) {
        hls.destroy();
      }
      // 不主动清空 src：保留 currentTime 供卸载前的历史写入读取。
    };
  }, [resolved]);

  // 播放进度 → 历史记录（5 秒节流，播放/暂停立即写）。
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !resolved) {
      return;
    }

    let lastWrite = 0;
    const write = async (force: boolean) => {
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
        positionMs: Math.round(video.currentTime * 1000),
        durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined,
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
      setTimeMs(video.currentTime * 1000);
      void write(false);
    };
    const onMeta = () => {
      setDurationMs(Number.isFinite(video.duration) ? video.duration * 1000 : 0);
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
      void write(true);
    };
  }, [resolved, siteKey, vodId, vodName, playUrl]);

  const currentLine = lines[lineIndex] ?? null;
  const canPrev = currentLine !== null && episodeIndex > 0;
  const canNext = currentLine !== null && episodeIndex < currentLine.episodes.length - 1;

  const goEpisode = (delta: number) => {
    if (!currentLine) {
      return;
    }
    const next = episodeIndex + delta;
    if (next < 0 || next >= currentLine.episodes.length) {
      return;
    }
    const episode = currentLine.episodes[next];
    navigate(
      {
        name: "player",
        siteKey,
        vodId,
        vodName,
        playUrl: episode.url,
        episodeName: episode.name,
      },
      true,
    );
  };

  const playExternal = async () => {
    const target = resolved?.url || playUrl;
    try {
      await api.openExternal(target);
    } catch (err) {
      setVideoError(`打开外部播放器失败：${toAppError(err).message}`);
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
        <span className="page-meta">{progressLabel}</span>
      </header>

      {switchTip ? <p className="tip">{switchTip}</p> : null}
      {videoError ? <ErrorBar message={videoError} /> : null}
      {resolveError ? <ErrorBar message={`播放地址解析失败：${resolveError}`} /> : null}

      <div className="player-stage">
        {resolving ? <Spinner label="正在解析播放地址…" /> : null}

        {!resolving && playable ? (
          <video ref={videoRef} className="player-video" controls playsInline />
        ) : null}

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
        {currentLine ? (
          <span className="player-bar__info">
            {currentLine.name} · 第 {episodeIndex + 1} / {currentLine.episodes.length} 集
          </span>
        ) : (
          <span className="player-bar__info">未获取到剧集列表</span>
        )}
        <button type="button" className="btn btn--primary" onClick={() => void playExternal()}>
          外部播放
        </button>
      </div>
    </section>
  );
}
