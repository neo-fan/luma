import { Tv } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Empty from "../components/Empty";
import Spinner from "../components/Spinner";
import AppSelect from "../components/AppSelect";
import ErrorBar from "../components/ErrorBar";
import PlayerStage from "../components/player/PlayerStage";
import PlayerResolution from "../components/player/PlayerResolution";
import LiveChannelRail from "../components/player/LiveChannelRail";
import LiveChannelBar from "../components/player/LiveChannelBar";
import LiveEpgPanel from "../components/LiveEpgPanel";
import { useLiveCatalog } from "../hooks/useLiveCatalog";
import { usePlayResolution } from "../hooks/usePlayResolution";
import { usePlayerEngine, BUILTIN_KINDS } from "../hooks/usePlayerEngine";
import type { LiveLineControl } from "../hooks/usePlayerEngine";
import { getLiveLine, setLiveLine } from "../lib/liveMemory";
import { readLiveChannel, rememberLiveChannel } from "../lib/liveChannels";
import { getEpgUrl } from "../lib/epgSettings";
import { EXTERNAL_PLAY_ENABLED } from "../lib/features";
import { notify } from "../lib/notify";
import { noticeTtl } from "../lib/notice";
import { resolutionBadge, resolutionDetail } from "../lib/resolution";
import type { VideoMeta } from "../lib/resolution";
import { api, errorMessage } from "../lib/invoke";
import type { LiveChannel, LiveSource } from "../types/tvbox";

interface LivePageProps {
  lives: LiveSource[];
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
 *   右侧 = 播放器 + 频道信息条 + 当日节目单
 *
 * 换台只改本页 state（playUrl 变化驱动解析与内核重建），不进路由、不重建页面。
 * 路由仍是 `/live`，侧栏高亮天然正确，也不再有「直播播放页」这个第二入口。
 */
export default function LivePage({ lives }: LivePageProps) {
  const catalog = useLiveCatalog(lives);

  /** 当前频道 + 线路。只记名字：源每次重拉，地址都可能换。 */
  const [pick, setPick] = useState<{ name: string; line: number } | null>(null);

  const [videoError, setVideoError] = useState("");
  /**
   * 结论性错误（这个频道的所有线路都试过了）：常驻到用户换台。
   * 它本身就是「该你操作了」的指令，8s 后自己消失等于把唯一的出口藏起来。
   */
  const [fatalError, setFatalError] = useState("");
  const [slowNotice, setSlowNotice] = useState("");
  const [switchTip, setSwitchTip] = useState("");
  /** 自动换线路进行中：这段时间不铺红色错误条（有希望自愈）。 */
  const [recovering, setRecovering] = useState(false);
  /** 信息条第二行：EPG 上报的「此刻正在播」。 */
  const [nowProgram, setNowProgram] = useState("");

  const { flat, sourceKey, source } = catalog;

  const channel = useMemo(
    () =>
      pick ? (flat.find((item) => item.name === pick.name) ?? null) : null,
    [flat, pick],
  );

  /** 上次渲染的源：换源后必须重新落点，别把 A 源的选中台带到 B 源。 */
  const lastSourceRef = useRef(sourceKey);
  useEffect(() => {
    if (lastSourceRef.current === sourceKey) {
      return;
    }
    lastSourceRef.current = sourceKey;
    setPick(null);
  }, [sourceKey]);

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
    liveUa: source?.ua,
    vodId: channel?.name ?? "",
    setSwitchTip,
    setVideoError,
  });

  const reloadRef = useRef<(() => void) | null>(null);
  reloadRef.current = () => {
    setVideoError("");
    setFatalError("");
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

  const selectLine = useCallback(
    (name: string, next: number, total: number) => {
      if (total <= 0) {
        return;
      }
      const idx = ((next % total) + total) % total;
      setLiveLine(sourceKey, name, idx);
      rememberLiveChannel(sourceKey, { name, line: idx });
      setVideoError("");
      setFatalError("");
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
      clearVerdict();
      verdictTimer.current = window.setTimeout(() => {
        verdictTimer.current = null;
        const video = videoRef.current;
        // readyState>=2 = 已有当前帧数据（哪怕用户暂停着），说明线路是通的。
        if (video && video.readyState >= 2) {
          return;
        }
        setVideoError("该频道暂时无法播放，可以换一个频道。");
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
    setFatalError("该频道的所有线路都无法播放，请换一个频道。");
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
      setFatalError("");
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

  usePlayerEngine({
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
    setVideoError,
  });

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
      setSwitchTip("");
      selectLine(next.name, idx, next.lines.length);
    },
    [pick, selectLine, sourceKey],
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

  const playExternal = async () => {
    if (!playUrl) {
      return;
    }
    try {
      await api.openExternal(resolved?.url || playUrl);
    } catch (err) {
      setVideoError(`打开外部播放器失败：${errorMessage(err)}`);
    }
  };

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
        {switchTip ? <p className="tip">{switchTip}</p> : null}
        {/* 两类错误分开：
          · tone="warn"＝「此刻这条线路这一下不行」，画面可能已在别的线路上
            播着，8s 带倒计时自动收起（时长见 lib/notice.ts）；
          · 默认 tone="error"＝「该频道所有线路都试过了」，这是要用户动手的
            结论，常驻到换台为止。 */}
        {videoError && !recovering ? (
          <ErrorBar message={videoError} lifetime="timed" />
        ) : null}
        {channel && resolveError && !recovering ? (
          <ErrorBar
            message={`播放地址解析失败：${resolveError}`}
            lifetime="timed"
          />
        ) : null}
        {fatalError && !recovering ? <ErrorBar message={fatalError} /> : null}

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
            {channel ? (
              <>
                <PlayerStage
                  resolving={resolving}
                  stage={stage}
                  reloading={reloading}
                  playable={playable}
                  recovering={recovering}
                  slowText={slowNotice}
                  resolveError={resolveError}
                  retryable={resolveRetryable}
                  containerRef={containerRef}
                />
                <PlayerResolution
                  host={playerRoot}
                  label={resolutionBadge(videoMeta)}
                  detail={resolutionDetail(videoMeta.width, videoMeta.height)}
                />
                <LiveChannelBar
                  channelName={channel.name}
                  program={nowProgram}
                  lineCount={channel.lines.length}
                  lineIndex={lineIdx}
                  onPickLine={(index) =>
                    selectLine(channel.name, index, channel.lines.length)
                  }
                  onPlayExternal={
                    EXTERNAL_PLAY_ENABLED
                      ? () => void playExternal()
                      : undefined
                  }
                />
                <LiveEpgPanel
                  channelName={channel.name}
                  onNow={setNowProgram}
                />
              </>
            ) : catalog.loading ? (
              <div className="live-main__placeholder">
                <Spinner label="正在读取频道…" />
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
