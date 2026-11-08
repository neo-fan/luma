import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import type { Navigate } from "../App";
import ErrorBar from "../components/ErrorBar";
import Spinner from "../components/Spinner";
import { formatDuration, parsePlayLines } from "../lib/format";
import type { PlayLine } from "../lib/format";
import { api, toAppError } from "../lib/invoke";
import type { HistoryItem, PlayResolved } from "../types/tvbox";

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

  // 挂载 / 销毁播放内核。
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !resolved) {
      return;
    }
    const source = resolved.proxyUrl;
    const onError = () => setVideoError("播放器加载失败，可尝试外部播放。");
    video.addEventListener("error", onError);

    let hls: Hls | null = null;

    if (resolved.kind === "hls") {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = source;
      } else if (Hls.isSupported()) {
        hls = new Hls({ enableWorker: true });
        hls.loadSource(source);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            setVideoError(`HLS 播放失败：${data.details}`);
          }
        });
      } else {
        setVideoError("当前环境不支持 HLS 内置播放，请使用外部播放。");
      }
    } else if (resolved.kind === "flv" || resolved.kind === "file") {
      video.src = source;
    } else {
      setVideoError("该地址需要外部播放器。");
    }

    return () => {
      video.removeEventListener("error", onError);
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
