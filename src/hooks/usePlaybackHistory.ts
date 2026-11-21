import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import { ledgerSuccess } from "../lib/failoverLedger";
import { resolutionFromVideo } from "../lib/resolution";
import { episodeNumber } from "../lib/sources";
import { api } from "../lib/invoke";
import { parseSkipConfig, parseSkipEnabled, serializeSkipConfig } from "../lib/skipSegments";
import type { SkipSegment } from "../lib/skipSegments";
import type { HistoryItem, PlayResolved } from "../types/luma";

export interface UsePlaybackHistoryOptions {
  siteKey: string;
  vodId: string;
  vodName: string;
  episodeName: string;
  playUrl: string;
  /** 自动换线记账 key：loadedmetadata 确认可播时恢复跳转预算。 */
  ledgerKey: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  resolved: PlayResolved | null;
  /** 原地换源覆盖后的身份：历史按它写，换源后不记回旧站。 */
  activeSiteKey: string;
  activeVodId: string;
  activeVodName: string;
  /** 续播起点（ms）：载入历史时填，内核 loadedmetadata 消费一次即清零。 */
  resumeMsRef: MutableRefObject<number>;
  /** 卸载时的进度快照：ArtPlayer 已清 src，最后一次写入用它。 */
  lastMediaRef: MutableRefObject<{ positionMs: number; durationMs?: number }>;
  /** 封面 / 备注 / 站点名（详情晚到时由 5 秒节流写入补上）。 */
  historyMetaRef: MutableRefObject<{ pic: string; remarks: string; siteName: string }>;
  /** 当前集名 / 线路名 / 当前集源地址（随剧集列表异步确定，用 ref 不进 effect 依赖）。 */
  historyLabelRef: MutableRefObject<{
    episodeName: string;
    playFrom: string;
    /**
     * 当前真正在播那一集的源地址。
     *
     * 原地换集不改路由，页面的 `playUrl` 参数只代表**进入时**那一集；用它写
     * 历史会拼出「第 40 集的地址 + 第 37 集的集名」，详情页遂两集同时标
     * 「上次看到」。所以写回一律取这里。
     */
    playUrl: string;
  }>;
  /**
   * 立即写一次历史的通道：由页面创建并同时交给切换编排（换集/换源前 flush），
   * 这里在进度 effect 里挂上实现。外部持有是为了解开「编排要 flush、历史要
   * display」的顺序环。
   */
  flushHistoryRef: MutableRefObject<(() => void) | null>;
  /**
   * 播放器实例的「挂载信号」（页面持有 playerRoot state，引擎建/拆实例时变化）。
   *
   * 本 hook 的调用点必须排在 `usePlayerEngine` **之前**（引擎参数要用它的
   * read / flush 通道），于是 `resolved` 到达那次渲染里进度 effect 先跑，
   * `videoRef.current` 还是 null → 早退，而 deps 里没有任何后续会变的量 →
   * play / pause / timeupdate 监听永远挂不上，「在播却不写历史」（2026-11-20
   * 实测：点播出画播放，`history_list` 恒空）。引擎在创建路径里先写
   * `videoRef.current = video` 再回调 `onPlayerRoot`，所以该信号变化后的
   * 那一次渲染必然能读到活着的元素。换集走原地换流、元素不换，不受影响。
   */
  attachSignal: unknown;
}

export interface PlaybackHistory {
  /** 这部剧记忆的倍速（0 = 没设过，播放侧按 1.0 起播）。 */
  readRememberedRate: () => number;
  rememberedRateRef: MutableRefObject<number>;
  /** 这部剧的片头/片尾配置（ref 供内核懒读，不触发重渲染）。 */
  readRememberedSkip: () => SkipSegment[];
  rememberedSkipRef: MutableRefObject<SkipSegment[]>;
  /** 立即写一次历史的通道：切集 / 换源 / 改倍速后 flush，不等 5 秒节流。 */
  flushHistoryRef: MutableRefObject<(() => void) | null>;
  /** 片头/片尾配置镜像 state：ref 供引擎懒读，state 供配置弹窗受控显示。 */
  skipConfig: SkipSegment[];
  setSkipConfig: Dispatch<SetStateAction<SkipSegment[]>>;
  /**
   * 这部剧的「跳过」开关。关掉只影响是否发起跳转，不丢已配好的时长；
   * 与 skipConfig 一样按剧存进 `skip_json`。
   */
  skipEnabled: boolean;
  setSkipEnabled: (enabled: boolean) => void;
}

/**
 * 播放历史数据层（从 PlayerPage 原样搬出，行为零改动）。
 *
 * 两件事：① 进页读一次历史，摘出这部剧的倍速 / 片头片尾配置 / 续播起点；
 * ② 播放进度按 5 秒节流写回（播放 / 暂停立即写、卸载用快照补一次）。
 * 写回需要的集名 / 线路名 / 封面元数据由调用方以 ref 提供（随异步数据更新，
 * 绝不进 effect 依赖重建监听）。刷新路径可能已写入更准的进度（resumeMsRef
 * 非 0），历史晚到时不得覆盖。
 */
export function usePlaybackHistory({
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
  attachSignal,
}: UsePlaybackHistoryOptions): PlaybackHistory {
  /**
   * 这部剧记忆的倍速（0 = 从没设过，播放侧按 1.0 起播）。
   *
   * 由 history 查询异步填、由内核的倍速变更回调更新。用 ref 不用 state：
   * 它不该触发整页重渲染，更不能进播放内核 effect 的依赖（会重建实例）。
   */
  const rememberedRateRef = useRef(0);
  const readRememberedRate = useCallback(() => rememberedRateRef.current, []);
  /**
   * 这部剧的片头/片尾跳过配置。同倍速：ref 承载（不触发重渲染、不进内核依赖），
   * 由 history 查询异步填、由配置 UI 更新。
   */
  const rememberedSkipRef = useRef<SkipSegment[]>([]);
  const readRememberedSkip = useCallback(() => rememberedSkipRef.current, []);
  /** 配置镜像 state：ref 供引擎懒读不触发重渲染，state 供浮层编辑器受控显示。 */
  const [skipConfig, setSkipConfig] = useState<SkipSegment[]>([]);
  const [skipEnabled, setSkipEnabledState] = useState(true);
  /** 开关同时更新 ref（写历史时不必等渲染）与 state（弹窗受控）。 */
  const skipEnabledRef = useRef(true);
  const setSkipEnabled = useCallback((enabled: boolean) => {
    skipEnabledRef.current = enabled;
    setSkipEnabledState(enabled);
  }, []);
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
        // 倍速与续播互不牵连：进度太靠前、已经看完、换到别的集，都不该让人
        // 顺手丢掉这部剧的倍速，所以要在续播那些提前返回之前先摘出来。
        if (hit?.rate) {
          rememberedRateRef.current = hit.rate;
        }
        // 片头/片尾配置与倍速同性质：按剧记忆，续播那些提前返回之前先摘出来。
        if (hit?.skipJson) {
          const segs = parseSkipConfig(hit.skipJson);
          const enabled = parseSkipEnabled(hit.skipJson);
          rememberedSkipRef.current = segs;
          skipEnabledRef.current = enabled;
          setSkipConfig(segs);
          setSkipEnabledState(enabled);
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, vodId, playUrl, vodName, episodeName]);

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
      const label = historyLabelRef.current;
      const item: HistoryItem = {
        siteKey: activeSiteKey,
        vodId: activeVodId,
        name: activeVodName,
        pic: historyMetaRef.current.pic,
        remarks: historyMetaRef.current.remarks,
        siteName: historyMetaRef.current.siteName,
        // 当前在播那一集的地址（不是进入播放页时的路由地址，见 ref 类型注释）。
        playUrl: label.playUrl || playUrl,
        episodeName: label.episodeName,
        playFrom: label.playFrom,
        // 语义集号：跨源续播按集号匹配，比集名「第37集 / 37 / EP37」稳。
        episodeNumber: episodeNumber(label.episodeName) ?? undefined,
        resolution: knownResolution,
        // 0 = 这次写入没带倍速，宿主侧不会覆盖库里已有的值。
        rate: rememberedRateRef.current,
        // 片头/片尾配置随这部剧写回（后端跨源继承，见 db/playback.rs）。
        skipJson: serializeSkipConfig(rememberedSkipRef.current, skipEnabledRef.current),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, activeSiteKey, activeVodId, activeVodName, playUrl, ledgerKey, attachSignal]);

  return {
    readRememberedRate,
    readRememberedSkip,
    rememberedRateRef,
    rememberedSkipRef,
    flushHistoryRef,
    skipConfig,
    setSkipConfig,
    skipEnabled,
    setSkipEnabled,
  };
}
