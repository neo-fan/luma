import { Tv } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Empty from "../components/Empty";
import Spinner from "../components/Spinner";
import AppSelect from "../components/AppSelect";
import ErrorBar from "../components/ErrorBar";
import PlayerStage from "../components/player/PlayerStage";
import PlayerResolution from "../components/player/PlayerResolution";
import LiveChannelRail from "../components/player/LiveChannelRail";
import LiveEpgPanel from "../components/LiveEpgPanel";
import { useLiveCatalog } from "../hooks/useLiveCatalog";
import { usePlayResolution } from "../hooks/usePlayResolution";
import { usePlaybackIndicator } from "../hooks/usePlaybackIndicator";
import { usePlayerEngine, BUILTIN_KINDS } from "../hooks/usePlayerEngine";
import { useAppStore } from "../stores/appStore";
import type { LiveLineControl } from "../hooks/usePlayerEngine";
import { getLiveLine, setLiveLine } from "../lib/liveMemory";
import { readLiveChannel, rememberLiveChannel } from "../lib/liveChannels";
import { getEpgUrl } from "../lib/epgSettings";
import { notify } from "../lib/notify";
import { noticeTtl } from "../lib/notice";
import { classifyLiveFailure, liveFailureMessage } from "../lib/playErrors";
import { mediaAdvanced } from "../lib/mediaAlive";
import type {
  LiveFailureInfo,
  LiveFailureStage,
} from "../lib/playErrors";
import { resolutionBadge, resolutionDetail } from "../lib/resolution";
import type { VideoMeta } from "../lib/resolution";
import { api } from "../lib/invoke";
import type { LiveChannel, LiveSource } from "../types/luma";

interface LivePageProps {
  lives: LiveSource[];
  /** 是否停在点播播放页：为 true 时直播必须让出声音（直播与点播只能一个在播）。 */
  vodActive?: boolean;
  /** 当前路由是否就是直播页：用户主动进来时直播要接管声音，而不是干等。 */
  liveActive?: boolean;
}

/**
 * 直播页：**直接就是播放页**。
 *
 * 之前是「频道列表页 → 播放页」两级：点一个台要整页 navigate 到 `/player/live/:name`，
 * 换台再 navigate 一次，而每个台都要重建一遍 `PlayerPage`（连带剧集列表、收藏、
 * 历史、换源这些点播才需要的东西全跑一遍）。直播的心智是「打开就是某个台，
 * 换台只差一次点击」，所以 `/live` 本身收敛成播放页：
 *
 *   左侧 = 常驻频道目录（搜索 / 分组 / 上一台下一台）
 *   右侧 = 播放器（频道名与清晰度叠在画面左上角）+ 当日节目单
 *
 * 换台只改本页 state（playUrl 变化驱动解析与内核重建），不进路由、不重建页面。
 * 路由仍是 `/live`，侧栏高亮天然正确，也不再有「直播播放页」这个第二入口。
 */
export default function LivePage({
  lives,
  vodActive = false,
  liveActive = false,
}: LivePageProps) {
  const catalog = useLiveCatalog(lives);

  /** 当前频道 + 线路。只记名字：源每次重拉，地址都可能换。 */
  const [pick, setPick] = useState<{ name: string; line: number } | null>(null);

  const [videoError, setVideoError] = useState("");
  /**
   * `videoError` 的来源阶段：内核报错（play）还是「单线路等 4s 仍没出画」的
   * 结论（single-line）。阶段决定文案该引导「换线路」还是「换频道」。
   */
  const [videoStage, setVideoStage] = useState<LiveFailureStage>("play");
  /** 最近一次内核报错原文：4s 判死时 timer 回调读 state 会拿到旧值，用 ref 承接。 */
  const lastErrorRef = useRef("");
  lastErrorRef.current = videoError;
  /**
   * 结论性错误（这个频道的所有线路都试过了）：常驻到用户换台。
   * 它本身就是「该你操作了」的指令，8s 后自己消失等于把唯一的出口藏起来。
   */
  const [fatalError, setFatalError] = useState<LiveFailureInfo | null>(null);
  const [slowNotice, setSlowNotice] = useState("");
  const [switchTip, setSwitchTip] = useState("");
  /** 自动换线路进行中：这段时间不铺红色错误条（有希望自愈）。 */
  const [recovering, setRecovering] = useState(false);

  const { flat, sourceKey, source } = catalog;

  const channel = useMemo(
    () =>
      pick ? (flat.find((item) => item.name === pick.name) ?? null) : null,
    [flat, pick],
  );

  /** 上次渲染的源：换源后必须重新落点，别把 A 源的选中台带到 B 源。 */
  const lastSourceRef = useRef(sourceKey);

  /**
   * 落点：优先回到上次看的那个台（按源记忆），它已不在列表里就第一个台。
   * 切源后旧频道大概率不存在，同样走这条兜底。
   */
  useEffect(() => {
    if (flat.length === 0) {
      return;
    }
    if (pick && flat.some((item) => item.name === pick.name)) {
      return;
    }
    const remembered = readLiveChannel(sourceKey);
    const hit = remembered
      ? flat.find((item) => item.name === remembered.name)
      : null;
    const next = hit ?? flat[0];
    const line = hit
      ? Math.min(
          Math.max(remembered?.line ?? 0, 0),
          Math.max(next.lines.length - 1, 0),
        )
      : 0;
    setPick({ name: next.name, line });
  }, [flat, sourceKey, pick]);

  const lines = channel?.lines ?? [];
  const lineIdx = Math.min(
    Math.max(pick?.line ?? 0, 0),
    Math.max(lines.length - 1, 0),
  );
  const playUrl = lines[lineIdx] ?? "";

  /* ---------- 播放器 ---------- */

  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastMediaRef = useRef<{ positionMs: number; durationMs?: number }>({
    positionMs: 0,
  });
  const failoverStarted = useRef(false);
  const lineSwitchStarted = useRef(false);
  const liveLineRef = useRef<LiveLineControl | null>(null);
  const [playerRoot, setPlayerRoot] = useState<HTMLDivElement | null>(null);
  const [videoMeta, setVideoMeta] = useState<VideoMeta>({
    width: 0,
    height: 0,
  });

  /* ---------- 直播 / 点播互斥（只有一个能出声） ---------- */

  /** 这次暂停是我们为了给点播让路做的：回到直播页时只恢复自己暂停的那一次。 */
  const pausedForVod = useRef(false);
  /** 点播是否真的在出声（后台也算）。路由之外的这半条件是双声的根治点。 */
  const vodPlaying = useAppStore((state) => state.mediaPlaying.vod);
  const setMediaPlaying = useAppStore((state) => state.setMediaPlaying);

  /**
   * 点播播放器常驻在 AppShell 里（`.player-host`），直播出画时把它按停。
   * 不做「暂停再恢复」的账：点播那边会有自己的播放按钮，用户回来点一下即可，
   * 反过来自动播放反而可能把用户已经放弃的片子续上。
   */
  const pauseVodMedia = useCallback(() => {
    document
      .querySelectorAll<HTMLVideoElement>(".player-host video")
      .forEach((item) => {
        if (!item.paused) {
          item.pause();
        }
      });
  }, []);

  /**
   * 进点播播放页 → 直播暂停；离开点播页 → 恢复本次暂停。
   * 页面本身挂在常驻层里不会卸载，所以这里只是 pause/play，不重建内核。
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    // 停在直播页时直播说了算：点播要么已经让位，要么马上让它让位（见下一个
    // effect）。这里只在「人不在直播页」时才为点播退让，否则从播放页切回来
    // 会因为点播还在后台播而被永久按停，画面停在黑屏、也没有按钮提示。
    if (!liveActive && (vodActive || vodPlaying)) {
      if (!video.paused) {
        video.pause();
        pausedForVod.current = true;
      }
      return;
    }
    if (pausedForVod.current) {
      pausedForVod.current = false;
      void video.play().catch(() => {
        /* 被浏览器拦下就停在原地，用户点播放器上的播放即可 */
      });
    }
  }, [vodActive, vodPlaying, liveActive, playUrl]);

  /**
   * 用户主动回到直播页 → 直播接管声音：按停后台点播（并清掉侧栏绿点），
   * 自己重新起播。之前只靠「让路记账」恢复，点播在后台播着时直播永远起不来，
   * 画面就停在黑屏。
   */
  useEffect(() => {
    if (!liveActive) {
      return;
    }
    const video = videoRef.current;
    if (!video) {
      return;
    }
    pauseVodMedia();
    if (vodPlaying) {
      setMediaPlaying("vod", false);
    }
    pausedForVod.current = false;
    if (video.paused) {
      void video.play().catch(() => {
        /* 没有用户手势时可能被拦；用户点播放器上的播放即可 */
      });
    }
  }, [liveActive, pauseVodMedia, setMediaPlaying, vodPlaying, playUrl]);

  // 出画即认领声音：此时点播那边（如果还在后台播）必须让位。
  useEffect(() => {
    if (videoMeta.width > 0) {
      pauseVodMedia();
    }
  }, [videoMeta.width, channel?.name, pauseVodMedia]);

  /**
   * 内核 / 解析钩子只会 set 字符串；这里顺手把阶段打回 `play`，避免上一轮
   * 「单线路判死」的阶段泄漏到新的错误上（那样会把只换线路就能解决的错误
   * 说成「只能换频道」）。
   */
  const setEngineVideoError = useCallback<typeof setVideoError>((value) => {
    // 换源过程中没有频道，旧内核（上一条频道/上一个源）的报错不属于这一轮：
    // 直接丢掉，避免「正在读取频道…」旁边挂着上一条「播放失败」。
    if (value && !channel) {
      return;
    }
    setVideoStage("play");
    setVideoError(value);
  }, [channel]);

  const {
    resolved,
    resolving,
    stage,
    reloading,
    resolveError,
    resolveRetryable,
    reload,
  } = usePlayResolution({
    siteKey: "live",
    playUrl,
    // 频道级 UA/Referer（m3u 的 `http-user-agent` / `http-referer`）优先：
    // 咪咕系央视/卫视不带它直接 404，源级 `lives[].ua` 只是兜底。
    liveUa: channel?.ua || source?.ua,
    liveReferer: channel?.referer,
    vodId: channel?.name ?? "",
    setSwitchTip,
    setVideoError: setEngineVideoError,
  });

  const reloadRef = useRef<(() => void) | null>(null);
  reloadRef.current = () => {
    setVideoError("");
    setVideoStage("play");
    setFatalError(null);
    setSwitchTip("");
    reload();
  };

  /** 本频道这一轮已经试过的线路：避免「A→B→A」来回切。 */
  const triedRef = useRef<Set<number>>(new Set());
  /** 单线路「判死」的延迟结论计时器：期间出画就撤回，见 `switchOrFailover`。 */
  const verdictTimer = useRef<number | null>(null);
  /** 自动换线的落点计算要读最新状态，用 ref 承接（内核只拿一个函数）。 */
  const switchOrFailoverRef = useRef<() => Promise<void>>(async () => {});

  const clearVerdict = useCallback(() => {
    if (verdictTimer.current !== null) {
      window.clearTimeout(verdictTimer.current);
      verdictTimer.current = null;
    }
  }, []);

  /**
   * 换源 = 一次全新的播放尝试：上一源的错误、提示、换线记账全部作废。
   *
   * 这段必须放在 `clearVerdict` / `triedRef` 之后定义（它们是 const），
   * 但逻辑上就是「sourceKey 变了」。漏掉它会先看到上一条「播放失败」，
   * 而画面中央还是新源的「没有可播放的频道」——两个不同源的结论同屏。
   */
  useEffect(() => {
    if (lastSourceRef.current === sourceKey) {
      return;
    }
    lastSourceRef.current = sourceKey;
    clearVerdict();
    triedRef.current.clear();
    setPick(null);
    setVideoError("");
    lastErrorRef.current = "";
    setVideoStage("play");
    setFatalError(null);
    setSlowNotice("");
    setSwitchTip("");
    setRecovering(false);
    failoverStarted.current = false;
    lineSwitchStarted.current = false;
  }, [sourceKey, clearVerdict]);

  const selectLine = useCallback(
    (name: string, next: number, total: number) => {
      if (total <= 0) {
        return;
      }
      const idx = ((next % total) + total) % total;
      setLiveLine(sourceKey, name, idx);
      rememberLiveChannel(sourceKey, { name, line: idx });
      setVideoError("");
      setVideoStage("play");
      setFatalError(null);
      setSwitchTip("");
      setPick({ name, line: idx });
    },
    [sourceKey],
  );

  /**
   * 自动换线：同一频道的下一线路，试完为止。
   *
   * 直播没有「换源」概念（频道是源的一部分），能做的只有换这个频道的另一条
   * 地址；全部失败就把结论交给用户——目录就在左边，换台比等下去快。
   */
  switchOrFailoverRef.current = async () => {
    if (!channel) {
      return;
    }
    const total = channel.lines.length;
    const tried = triedRef.current;
    tried.add(lineIdx);
    if (total <= 1) {
      // 只有一条线路时没有可换的目标，但**一次 error 不构成结论**：直播分片
      // 瞬时 5xx、hls 抖动都会先抛 error 再自愈——用户实测过「画面已经在放
      // 1080P，顶上却挂着『该频道暂时无法播放』」。等 4s，期间恢复就撤回。
      // 判死前的快照：音频先出、视频轨还在解码时 `currentTime` 会在窗口内
      // 前进——这同样是「线路是通的」的证据，不能只盯画面和缓冲等级。
      const startTime = videoRef.current?.currentTime ?? 0;
      clearVerdict();
      verdictTimer.current = window.setTimeout(() => {
        verdictTimer.current = null;
        const video = videoRef.current;
        // readyState>=2 = 已有当前帧数据（哪怕用户暂停着）；时钟在窗口内
        // 前进 = 确实在放（可能只是音频）。任一成立都说明线路是通的。
        if (
          video &&
          (video.readyState >= 2 || mediaAdvanced(video, startTime))
        ) {
          return;
        }
        // 单线路判死：把内核给的最后一句原文带进归类，能看出原因的按原因
        // 引导（解码 / 超时 / 网络），看不出原因才用「换频道」的结论文案。
        const lastError = lastErrorRef.current;
        setVideoStage("single-line");
        setVideoError(
          lastError || liveFailureMessage({ stage: "single-line" }),
        );
      }, 4_000);
      return;
    }
    for (let step = 1; step < total; step += 1) {
      const idx = (lineIdx + step) % total;
      if (tried.has(idx)) {
        continue;
      }
      setRecovering(true);
      // 自动换线是「后台已经帮你做了」的事件，不是页面状态：走全局 toast，
      // 不占顶部横幅（那条位置留给需要用户处置的错误）。
      selectLine(channel.name, idx, total);
      notify.warn(
        `线路 ${lineIdx + 1} 无法播放，已自动切到线路 ${idx + 1}/${total}`,
      );
      return;
    }
    setRecovering(false);
    setFatalError(classifyLiveFailure({ stage: "exhausted" }));
    setVideoError("");
  };

  /* 换频道：重置「试过的线路」与内核闸门；同一频道换线路只重置闸门。 */
  useEffect(() => {
    triedRef.current.clear();
    failoverStarted.current = false;
    lineSwitchStarted.current = false;
    clearVerdict();
    setRecovering(false);
  }, [channel?.name, clearVerdict]);

  useEffect(() => {
    failoverStarted.current = false;
    lineSwitchStarted.current = false;
    clearVerdict();
    setVideoMeta({ width: 0, height: 0 });
    setVideoStage("play");
    // 等待秒数属于上一条流：换台 / 换线后必须归零，否则会出现
    // 「已等待 906s」这种跨切换残留（2026-11-15 用户截图）。
    setSlowNotice("");
  }, [lineIdx, playUrl, clearVerdict]);

  useEffect(() => clearVerdict, [clearVerdict]);

  /**
   * 出画即撤回错误：`videoWidth > 0` 说明已经有画面，此时「无法播放」这类
   * 上一轮的判决必然过期。慢提示同理，一并收掉。
   */
  useEffect(() => {
    if (videoMeta.width > 0) {
      clearVerdict();
      setVideoError("");
      setVideoStage("play");
      setFatalError(null);
      setSlowNotice("");
    }
  }, [videoMeta.width, clearVerdict]);

  /** 「解析来自某解析器」这类附带说明是告知，按统一时长表走。 */
  useEffect(() => {
    if (!switchTip) {
      return;
    }
    const timer = window.setTimeout(() => setSwitchTip(""), noticeTtl("info"));
    return () => window.clearTimeout(timer);
  }, [switchTip]);

  const engine = usePlayerEngine({
    containerRef,
    videoRef,
    lastMediaRef,
    failoverStarted,
    lineSwitchStarted,
    switchOrFailoverRef,
    liveLineRef,
    reloadRef,
    resolved,
    resolving,
    siteKey: "live",
    vodName: channel?.name ?? "",
    vodId: channel?.name ?? "",
    onVideoMeta: setVideoMeta,
    onPlayerRoot: setPlayerRoot,
    onSlowNotice: (text) => setSlowNotice(text ?? ""),
    setVideoError: setEngineVideoError,
  });

  // 常驻层切页不卸载：播放状态进全局 store，侧栏图标才能亮小圆点。
  usePlaybackIndicator(videoRef, "live", resolved);

  /**
   * 换台/换线与「源侧慢」的提示统一进播放器 notice：贴着画面、全屏可见。
   * 页面顶部只留错误条（那是需要用户决策的信息，不适合 2 秒自动消失）。
   */
  useEffect(() => {
    const text = switchTip || slowNotice;
    if (!text) {
      return;
    }
    engine.notice(text);
  }, [engine, switchTip, slowNotice]);

  /**
   * 解析失败也换线路——但要与「源还没答完」区分开。
   * 超时（`resolveRetryable`）保留当前线路让用户刷新；明确失败才顺延。
   */
  useEffect(() => {
    if (!channel || resolving || !resolveError || resolveRetryable) {
      return;
    }
    // 全部线路都试过了：`switchOrFailoverRef` 自己会给结论，别再触发。
    if (channel.lines.length <= triedRef.current.size) {
      return;
    }
    void switchOrFailoverRef.current();
  }, [channel, resolving, resolveError, resolveRetryable, lineIdx]);

  // 新线路出结果就撤掉「自动换线中」的抑制；12s 兜底防止状态卡住。
  useEffect(() => {
    if (resolved) {
      setRecovering(false);
    }
  }, [resolved]);

  useEffect(() => {
    if (!recovering) {
      return;
    }
    const timer = window.setTimeout(() => setRecovering(false), 12_000);
    return () => window.clearTimeout(timer);
  }, [recovering, playUrl]);

  /* ---------- 交互 ---------- */

  const playChannel = useCallback(
    (next: LiveChannel) => {
      // 换台就是「现在要看直播」：点播那边立刻让位，不等出画（否则一两秒双声）。
      pauseVodMedia();
      const remembered = getLiveLine(sourceKey, next.name);
      const idx = Math.min(
        Math.max(remembered, 0),
        Math.max(next.lines.length - 1, 0),
      );
      if (pick && pick.name === next.name && pick.line === idx) {
        // 点正在播的台 = 重连一次：用户遇到卡顿时最自然的动作就是再点一下。
        reloadRef.current?.();
        return;
      }
      setVideoError("");
      setVideoStage("play");
      setSwitchTip("");
      selectLine(next.name, idx, next.lines.length);
    },
    [pick, selectLine, sourceKey, pauseVodMedia],
  );

  const step = (delta: 1 | -1) => {
    if (!channel || flat.length === 0) {
      return;
    }
    const at = flat.findIndex((item) => item.name === channel.name);
    if (at < 0) {
      return;
    }
    const next = flat[(at + delta + flat.length) % flat.length];
    if (next) {
      playChannel(next);
    }
  };

  const position = channel
    ? flat.findIndex((item) => item.name === channel.name) + 1
    : 0;

  liveLineRef.current =
    channel && channel.lines.length > 1
      ? {
          lines: channel.lines,
          index: lineIdx,
          onPick: (index: number) =>
            selectLine(channel.name, index, channel.lines.length),
        }
      : null;

  const playable = resolved !== null && BUILTIN_KINDS.includes(resolved.kind);

  /**
   * 播放内核失败 / 单线路判死的统一归类。主文案与归因都只从
   * `classifyLiveFailure` 出，原始报错降级到 ErrorBar 的「技术详情」，
   * 界面不再把 `HLS 播放失败：manifestParsingError` 这类内部名当正文。
   */
  const videoFailure =
    videoError || videoStage === "single-line"
      ? classifyLiveFailure({ message: videoError, stage: videoStage })
      : null;

  /**
   * 解析失败 / 页面型地址的统一归类。
   *
   * `resolved.kind === "page"` 表示 `resolve_play` 的第 4 级嗅探也没拿到媒体
   * 流（`domain/play.rs` 的 page 分支）：地址本身是网页，播放器无从下手。
   * 这是「该换频道/换源」的结论，所以用常驻横幅；普通解析失败仍是时效性
   * 结论，保持 8s 自动收起。
   */
  const resolveFailure = resolveError
    ? classifyLiveFailure({ message: resolveError, stage: "resolve" })
    : resolved !== null && !playable && !reloading
      ? classifyLiveFailure({ stage: "sniff" })
      : null;

  // 进页面就预热节目单：默认 7.6MB XMLTV，点开才发现「加载节目单…」像坏了。
  useEffect(() => {
    void api.liveEpgWarm(getEpgUrl()).catch(() => {
      /* 预热失败不影响直播，真正打开节目单时还会再试一次 */
    });
  }, []);

  if (lives.length === 0) {
    return (
      <section className="page">
        <header className="page-head">
          <h1 className="page-title">直播</h1>
        </header>
        <Empty
          title="当前配置没有直播源"
          description="导入带 lives[] 的配置后，这里会列出直播分组与频道。"
          icon={Tv}
        />
      </section>
    );
  }

  return (
    <section className="page page--live">
      {/* 页头在滚动区之外：换源 / 看频道数不会因为滚列表而消失。 */}
      <header className="page-head">
        <div className="page-head__main">
          <h1 className="page-title">直播</h1>
          {lives.length > 1 ? (
            <AppSelect
              ariaLabel="选择直播源"
              value={String(catalog.sourceIndex)}
              onChange={(value) => catalog.switchSource(Number(value))}
              options={lives.map((item, index) => ({
                value: String(index),
                label:
                  (item.name || `源 ${index + 1}`) +
                  (catalog.listable[index] ? "" : "（无列表）"),
                disabled: !catalog.listable[index],
                disabledHint: catalog.listable[index] ? undefined : "无列表",
              }))}
            />
          ) : null}
          <span className="page-meta">
            {flat.length > 0
              ? `${flat.length} 个频道`
              : catalog.loading
                ? "读取中…"
                : "—"}
          </span>
        </div>
      </header>
      <div className="page-body">
        <div className="live-layout">
          <LiveChannelRail
            groups={catalog.groups}
            loading={catalog.loading}
            error={catalog.error}
            onRefresh={catalog.refresh}
            currentName={channel?.name ?? ""}
            onPick={playChannel}
            onStep={step}
            position={position}
            total={flat.length}
          />

          <div className="live-main">
            {/* 两类错误分开：
          · lifetime="timed"＝「此刻这条线路这一下不行」，画面可能已在别的
            线路上播着，8s 带倒计时自动收起（时长见 lib/notice.ts）；
          · 默认 sticky＝「该频道所有线路都试过了」或「地址是网页、嗅探不到
            播放源」，这是要用户动手的结论，常驻到换台为止。
          主文案与归因由 lib/playErrors 的 classifyLiveFailure 统一给出，
          原始报错折叠进「技术详情」。 */}
            {videoFailure && !recovering && !catalog.loading ? (
          <ErrorBar
            message={videoFailure.message}
            hint={videoFailure.hint}
            detail={
              videoError && videoError !== videoFailure.message
                ? videoError
                : undefined
            }
            lifetime="timed"
          />
        ) : null}
            {resolveFailure && !recovering && !catalog.loading ? (
          <ErrorBar
            message={resolveFailure.message}
            hint={resolveFailure.hint}
            detail={resolveError || undefined}
            lifetime={resolveError ? "timed" : "sticky"}
          />
        ) : null}
            {fatalError && !recovering && !catalog.loading ? (
          <ErrorBar message={fatalError.message} hint={fatalError.hint} />
        ) : null}

            {channel ? (
              <>
                <PlayerStage
                  resolving={resolving}
                  stage={stage}
                  reloading={reloading}
                  playable={playable}
                  recovering={recovering}
                  resolveError={
                    resolveError ? (resolveFailure?.message ?? resolveError) : ""
                  }
                  retryable={resolveRetryable}
                  containerRef={containerRef}
                  onNextLine={() => {
                    void switchOrFailoverRef.current();
                  }}
                />
                <PlayerResolution
                  host={playerRoot}
                  channel={channel.name}
                  label={resolutionBadge(videoMeta)}
                  detail={resolutionDetail(videoMeta.width, videoMeta.height)}
                />
                <LiveEpgPanel channelName={channel.name} />
              </>
            ) : catalog.loading || flat.length > 0 ? (
              <div className="live-main__placeholder">
                <Spinner
                  label={catalog.loading ? "正在读取频道…" : "正在选择频道…"}
                />
              </div>
            ) : (
              <div className="live-main__placeholder">
                <Empty
                  title="没有可播放的频道"
                  description="换一个直播源，或点左侧的刷新重新拉取列表。"
                  icon={Tv}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
