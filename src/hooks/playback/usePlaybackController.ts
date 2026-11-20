/**
 * 播放页切换编排。
 *
 * 核心不变式：**只有一个播放目标真源**（`intent ?? committed`，详见
 * `playbackTarget.ts`），所有异步切换都围绕它产生意图、再落地。
 *
 * - 每次用户动作（选集 / 换源 / 下一集）只做一件事：产生一个 `PlaybackTarget`
 *   意图（`intent`），UI 立刻按它显示；后台解析完成后整体替换 `committed`
 *   （`commit`），`intent` 归零。显示恒为 `intent ?? committed`。
 * - 代次用 `switchToken`（单调 gen）：每产生一个意图就 `begin()` 抢占，解析
 *   可以并发，但落地前必须 `isCurrent(gen)`；真正切画面经 `commitGate` 串行，
 *   进锁后再校验一次代次 —— **最终落到画面的一定是最新一次选中**。
 * - 原地换集用 `switchQueue` 合并连点：忙时只保留最后一个意图；同步 `peek`
 *   判等（不走会滞后的渲染态），同一 tick 连点同一集不会「自己作废自己」。
 */
import { useCallback, useEffect, useRef, useReducer, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { createCommitGate, createSwitchToken, createManualHold } from "../../lib/switchToken";
import type { CommitGate, SwitchToken, ManualHold } from "../../lib/switchToken";
import { createSwitchQueue } from "../../lib/switchQueue";
import type { SwitchQueue } from "../../lib/switchQueue";
import { playbackReducer, displayTarget } from "./playbackTarget";
import type { PlaybackState, PlaybackTarget } from "./playbackTarget";
import { api, cacheKeys } from "../../lib/invoke";
import { errorMessage } from "../../lib/invoke";
import { CACHE_TTL, peekFresh } from "../../lib/queryClient";
import { parsePlayLines, sameEpisodeName } from "../../lib/format";
import type { PlayLine } from "../../lib/format";
import { pickMatchingEpisode } from "../../lib/sources";
import type { SourceOption } from "../../lib/sources";
import { locateEpisode, seedFromCachedDetail } from "../../lib/episodeSeed";
import type { EpisodeSeed } from "../../lib/episodeSeed";
import { resolveEpisodeTarget } from "../../lib/episodeResolve";
import { invalidateEpisodePlayCache, setEpisodePlayCache } from "../../lib/episodePlayCache";
import { resolveEpisodePlay } from "./episodePlayResolve";
import { playerRoute } from "./playerRoute";
import { firstPlayable } from "../../lib/probeRace";
import { probePlayable } from "../../lib/playProbe";
import { lineRank } from "../../lib/lineHealth";
import {
  ledgerBudget,
  ledgerCountSwitch,
  ledgerHasUrl,
  ledgerMarkSite,
  ledgerMarkUrl,
  ledgerSiteSeen,
  markAutoNav,
} from "../../lib/failoverLedger";
import { PLAY_FAILURE_HINT } from "../../lib/features";
import { log } from "../../lib/logger";
import { notify } from "../../lib/notify";
import type { Navigate } from "../../lib/nav";
import type { PlayResolved, VodInfo, ResultPage } from "../../types/luma";
import type { EpisodeNavControl, UsePlayerEngineHandle } from "../usePlayerEngine";

/** 手动意图持有期：覆盖「慢源 detail + 解析 + 50s 硬上限」的最坏手动路径。 */
const MANUAL_HOLD_MS = 60_000;
/** 「切换中」兜底：完成路径都收不回时，30s 后强制解除并作废在途结果。 */
const SWITCH_TIMEOUT_MS = 30_000;

export type PlaybackPhase = "idle" | "preparing" | "committing";

interface QueuePick {
  /** 目标所属源：跨源后同号集是不同目标，判等必须带上。 */
  siteKey: string;
  lineIndex: number;
  episodeIndex: number;
  gen: number;
}

export interface PlaybackControllerOptions {
  siteKey: string;
  siteName?: string;
  vodId: string;
  vodName: string;
  episodeName: string;
  playUrl: string;
  playFrom?: string;
  /** 站点 `changeable: 0` 时禁止跨站自动换源；手动换源不受限。 */
  allowFailover: boolean;
  ledgerKey: string;
  navigate: Navigate;
  /**
   * 播放内核句柄：由页面在渲染期回填。用 ref 而不用入参，是为了解开
   * 「controller 要 engine.switchSource、engine 要 controller.switching」的环。
   */
  engineRef: MutableRefObject<UsePlayerEngineHandle | null>;
  videoRef: MutableRefObject<HTMLVideoElement | null>;
  /** 当前路由地址的解析结论（usePlayResolution）。 */
  resolved: PlayResolved | null;
  setSwitchTip: Dispatch<SetStateAction<string>>;
  setVideoError: Dispatch<SetStateAction<string>>;
  setShowSources: Dispatch<SetStateAction<boolean>>;
  flushHistoryRef: MutableRefObject<(() => void) | null>;
  resumeMsRef: MutableRefObject<number>;
  /** 控制栏「下一集」的 ref：markPhase 直接改 switching 字段，抢先一拍。 */
  episodeNavRef: MutableRefObject<EpisodeNavControl | null>;
  failoverStarted: MutableRefObject<boolean>;
  lineSwitchStarted: MutableRefObject<boolean>;
  lineAttempt: MutableRefObject<Promise<boolean> | null>;
}

export interface PlaybackController {
  /** 显示真源（intent ?? committed）。 */
  display: PlaybackTarget;
  /** 已落地真源：历史 / 收藏 / 下一集基线。 */
  committed: PlaybackTarget;
  lines: PlayLine[];
  vod: VodInfo | null;
  panelLine: number;
  setPanelLine: (value: number) => void;
  phase: PlaybackPhase;
  switching: boolean;
  canPlayNext: boolean;
  nextLineBusy: boolean;
  /** 原地换后的真实播放地址（路由 playUrl 不跟改；页面渲染用它清错误条）。 */
  switchedUrlRef: MutableRefObject<string | null>;
  /** 真正在播的集身份：fatal 按它作废解析缓存。 */
  playingEpisodeRef: MutableRefObject<{ siteKey: string; playFrom: string; url: string }>;
  /** 自动自愈总线：页面预建、这里每渲染把最新结论挂上去，供 engine 使用。 */
  switchOrFailoverRef: MutableRefObject<() => Promise<void>>;
  selectEpisode: (targetLine: number, index: number) => void;
  goEpisode: (delta: number) => void;
  switchSource: (option: SourceOption) => Promise<void>;
  nextLine: () => void;
}

/** 首帧种子：详情已在 数据缓存 里时同步直出，避免信息卡先闪、面板先消失。 */
function readSeed(
  siteKey: string,
  vodId: string,
  playUrl: string,
  episodeName: string,
  playFrom: string,
): EpisodeSeed | null {
  if (siteKey === "live" || !vodId.trim()) {
    return null;
  }
  const cached = peekFresh<VodInfo[]>(cacheKeys.detail(siteKey, vodId), CACHE_TTL.detail);
  return seedFromCachedDetail(cached, playUrl, episodeName, playFrom);
}

export function usePlaybackController(
  options: PlaybackControllerOptions,
): PlaybackController {
  // 每渲染镜像最新入参；下面的回调身份稳定，读到的永远是最新渲染。
  const depsRef = useRef(options);
  depsRef.current = options;

  const {
    siteKey,
    siteName = "",
    vodId,
    vodName,
    episodeName,
    playUrl,
    playFrom = "",
    episodeNavRef,
    videoRef,
  } = options;

  const [seed] = useState<EpisodeSeed | null>(() =>
    readSeed(siteKey, vodId, playUrl, episodeName, playFrom),
  );

  const initialPlaybackState: PlaybackState = {
    committed: {
      siteKey,
      siteName,
      vodId,
      vodName,
      lines: seed?.lines ?? [],
      lineIndex: seed?.locus.line ?? 0,
      episodeIndex: seed?.locus.episode ?? 0,
    },
    intent: null,
  };
  const [state, dispatch] = useReducer(playbackReducer, initialPlaybackState);

  const [vod, setVod] = useState<VodInfo | null>(seed?.vod ?? null);
  const [panelLine, setPanelLineState] = useState(seed?.locus.line ?? 0);
  const [phase, setPhase] = useState<PlaybackPhase>("idle");
  const [nextLineBusy, setNextLineBusy] = useState(false);

  const switchToken = useRef<SwitchToken>(createSwitchToken());
  const commitGate = useRef<CommitGate>(createCommitGate(switchToken.current));
  const manualHoldRef = useRef<ManualHold>(createManualHold());
  const switchRunRef = useRef<(pick: QueuePick) => Promise<void>>(async () => undefined);
  const switchQueueRef = useRef<SwitchQueue<QueuePick> | null>(null);
  if (switchQueueRef.current === null) {
    switchQueueRef.current = createSwitchQueue<QueuePick>({
      // 判等必须含 siteKey：原地换源后 display 已是新源，但旧源在途 pick 的
      // running 可能还没释放；只比 lineIndex/episodeIndex 会把新源同号集的
      // 点击误判成重复而吞掉（跨源后同号 = 不同目标）。同源连点仍正确去重。
      equals: (a, b) =>
        a.siteKey === b.siteKey && a.lineIndex === b.lineIndex && a.episodeIndex === b.episodeIndex,
      run: (pick) => switchRunRef.current(pick),
    });
  }

  const switchedUrlRef = useRef<string | null>(null);
  // 真正在播的集身份：用路由参数初始化，首播失败 paths 自愈才能按真实 key
  // 作废那条坏缓存（否则空 key 的 invalidate 是 no-op，用户返回该集再踩同一个坏地址）。
  // 之后的原地换集 / 换源在 commit 回调里覆盖为最新值。
  const playingEpisodeRef = useRef({ siteKey, playFrom, url: playUrl });
  const switchOrFailoverRef = useRef<() => Promise<void>>(async () => undefined);

  const display = displayTarget(state);
  const committed = state.committed;
  const displayRef = useRef(display);
  displayRef.current = display;
  const committedRef = useRef(committed);
  committedRef.current = committed;

  const committedLine = committed.lines[committed.lineIndex] ?? null;
  const canPlayNext = Boolean(
    committedLine && committed.episodeIndex + 1 < committedLine.episodes.length,
  );

  /** 统一切换态：state + 控制栏镜像一起动。 */
  const markPhase = useCallback(
    (next: PlaybackPhase) => {
      if (episodeNavRef.current) {
        episodeNavRef.current.switching = next !== "idle";
      }
      setPhase(next);
    },
    [episodeNavRef],
  );

  /** 面板线路浏览：只换下方剧集表，不换流。 */
  const setPanelLine = useCallback((value: number) => {
    setPanelLineState(value);
  }, []);

  /**
   * 切换发起就停掉旧流：拿到新地址之前，播放器不该继续出声 / 走时间。
   *
   * 只 pause 不清 src——清 src 会触发 emptied/error，和「切换中」的 loading
   * 抢画面；pause 保留最后一帧，由 loading 覆盖层表达「正在换」。
   * 用户仍可继续点选集（A 语义），队列合并、只认最新，但播放器一次都不切。
   */
  const haltCurrentPlayback = useCallback(() => {
    const video = videoRef.current;
    if (video && !video.paused) {
      try {
        video.pause();
      } catch {
        /* 内核正在重建时 pause 可能抛，忽略 */
      }
    }
  }, [videoRef]);

  // 目录拉取：组件按 siteKey:vodId:playUrl 重建，这里首次挂载跑一次即可。
  useEffect(() => {
    if (siteKey === "live") {
      setVod(null);
      dispatch({ type: "catalog", lines: [] });
      return;
    }
    if (seed) {
      // 首帧种子已把 lines / 定位写进初始 state，无需再读一次同一条缓存。
      setVod(seed.vod);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const list = await api.detail(siteKey, vodId);
        if (!alive) {
          return;
        }
        const first = list && list.length > 0 ? list[0] : null;
        setVod(first);
        const lines = first
          ? parsePlayLines(first.vod_play_from, first.vod_play_url)
          : [];
        const locus = locateEpisode(lines, playUrl, episodeName, playFrom);
        dispatch({
          type: "reset",
          target: {
            siteKey,
            siteName,
            vodId,
            vodName,
            lines,
            lineIndex: locus.line,
            episodeIndex: locus.episode,
          },
        });
        setPanelLineState(locus.line);
      } catch {
        if (alive) {
          setVod(null);
          dispatch({ type: "catalog", lines: [] });
        }
      }
    })();
    return () => {
      alive = false;
    };
    // seed 是挂载快照；sites/siteName 变化不该重拉详情。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, vodId]);

  // 「切换中」兜底解除：完成路径漏收口时 30s 强制解除 UI 卡死态。
  //
  // 关键：这里 **只能复位 UI，绝不能作废在途代次 / 撤销意图 / 清队列**。
  // 解析硬上限是 50s（见 usePlayResolution 的 RESOLVE_HARD_CAP_MS），30s 兜底
  // 落在解析窗口内。若在此 begin()/cancel()/cancelPending()：
  //  - 在途解析 30~50s 真正完成时，成功路径的 commitGate.commit 与失败路径的
  //    fallback 都会被 isCurrent(gen) 判为过期而整段丢弃 → 画面停在旧帧、
  //    提示已被清空，用户看到「转半分钟圈后卡住」（实测 P0 竞态）；
  //  - 连点场景里 cancelPending 会丢掉最终意图（队列里最后那个 gen 才是要落地的），
  //    而当前 running 项又因代次过期被跳过 → 什么都不上屏。
  // 在途协程必须保留落地权利（manualHold 60s 保护期内自愈不会抢占），兜底只让
  // 转圈/提示消失，用户可继续操作，真正结果由 commit/fallback 正常收口。
  useEffect(() => {
    if (phase === "idle") {
      return;
    }
    const timer = window.setTimeout(() => {
      markPhase("idle");
      depsRef.current.setSwitchTip("");
    }, SWITCH_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [phase, markPhase]);

  // 新媒体 loadedmetadata 才撤「切换中」：旧媒体的早触发过，不会误清。
  useEffect(() => {
    if (phase === "idle") {
      return;
    }
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const onMeta = () => markPhase("idle");
    video.addEventListener("loadedmetadata", onMeta);
    return () => video.removeEventListener("loadedmetadata", onMeta);
  }, [phase, markPhase, videoRef]);

  /**
   * 落地一次切换：进串行提交门 → 换流 → 记「真正在播的集身份」→ 提交目标。
   *
   * 解析在锁外并发，进锁后再校验代次，所以最终上屏的一定是最新一次选中。
   * 换集与换源共用这一份，避免两边各写一遍后只有一边补了某项收口。
   */
  const applySwitch = useCallback(
    async (
      gen: number,
      play: PlayResolved,
      identity: { siteKey: string; playFrom: string; url: string },
      target: PlaybackTarget,
    ) => {
      const d = depsRef.current;
      d.resumeMsRef.current = 0;
      await commitGate.current.commit(gen, async () => {
        const engine = d.engineRef.current;
        if (!engine) {
          throw new Error("播放内核未就绪");
        }
        await engine.switchSource(play.proxyUrl);
        switchedUrlRef.current = play.proxyUrl;
        playingEpisodeRef.current = identity;
        dispatch({ type: "commit", target });
      });
    },
    [],
  );

  /** 点选集：乐观显示 + 入队；后台解析，落地经串行提交门。 */
  const selectEpisode = useCallback(
    (targetLine: number, index: number) => {
      const current = displayRef.current;
      const line = current.lines[targetLine];
      if (!line || index < 0 || index >= line.episodes.length) {
        return;
      }
      // 同步判等（不用渲染态）：同一目标已在跑 / 已排队就忽略，避免自己作废自己。
      // 必须含 siteKey：跨源后 display 已是新源，旧源在途 pick 仍是同号集，
      // 若只比 line/ep 会把新源的这次点击误判成重复而吞掉（与 equals 同口径）。
      const queue = switchQueueRef.current;
      const same = (pick: QueuePick | null | undefined) =>
        Boolean(
          pick &&
            pick.siteKey === current.siteKey &&
            pick.lineIndex === targetLine &&
            pick.episodeIndex === index,
        );
      if (same(queue?.peekRunning()) || same(queue?.peekPending())) {
        return;
      }
      manualHoldRef.current.engage(MANUAL_HOLD_MS);
      const { gen } = switchToken.current.begin();
      // 立刻停旧流：拿到新地址前播放器不出声；用户仍可继续点（队列合并、只认最新）。
      haltCurrentPlayback();
      const next: PlaybackTarget = { ...current, lineIndex: targetLine, episodeIndex: index };
      markPhase("preparing");
      dispatch({ type: "intent", target: next });
      depsRef.current.setSwitchTip(`正在切换到「${line.episodes[index].name}」…`);
      queue?.request({ siteKey: current.siteKey, lineIndex: targetLine, episodeIndex: index, gen });
    },
    [haltCurrentPlayback, markPhase],
  );

  /** 队列执行器：原地换集；失败/冷路径退回整页 navigate。 */
  const runEpisodeSwitch = useCallback(
    async ({ lineIndex: targetLine, episodeIndex: index, gen }: QueuePick) => {
      const d = depsRef.current;
      const current = displayRef.current;
      const line = current.lines[targetLine];
      if (!line || index < 0 || index >= line.episodes.length) {
        return;
      }
      const episode = line.episodes[index];
      const wasPlayingBefore = videoRef.current ? !videoRef.current.paused : false;
      markPhase("preparing");
      d.flushHistoryRef.current?.();

      const target: PlaybackTarget = { ...current, lineIndex: targetLine, episodeIndex: index };

      const fallback = () => {
        d.setSwitchTip("");
        videoRef.current = null;
        d.navigate(
          playerRoute({
            siteKey: current.siteKey,
            vodId: current.vodId,
            vodName: current.vodName,
            playUrl: episode.url,
            episodeName: episode.name,
            playFrom: line.name,
          }),
          true,
        );
      };

      if (!d.resolved) {
        // 冷路径也要确认仍是最新意图，被更新的选中抢先时不 navigate 回旧集。
        if (switchToken.current.isCurrent(gen)) {
          fallback();
        }
        return;
      }
      const previousKind = d.resolved.kind;
      try {
        const play = await resolveEpisodePlay(
          current.siteKey,
          line.name,
          episode.url,
          previousKind,
        );
        await applySwitch(
          gen,
          play,
          { siteKey: current.siteKey, playFrom: line.name, url: episode.url },
          target,
        );
        d.setSwitchTip(!wasPlayingBefore ? `已切到「${episode.name}」，点播放继续` : "");
      } catch (err) {
        invalidateEpisodePlayCache(current.siteKey, line.name, episode.url);
        log.warn("in-place episode switch failed", { message: errorMessage(err) });
        if (switchToken.current.isCurrent(gen)) {
          fallback();
        }
      }
      // 「切换中」不在此处清：画面交给新 <video>，由 loadedmetadata / 30s 兜底收口。
    },
    [applySwitch, markPhase, videoRef],
  );
  switchRunRef.current = runEpisodeSwitch;

  /** 手动换源：取新源详情、续播同一集、原地换流；失败才整页重建。 */
  const switchSource = useCallback(
    async (option: SourceOption) => {
      const d = depsRef.current;
      const current = displayRef.current;
      manualHoldRef.current.engage(MANUAL_HOLD_MS);
      const { gen } = switchToken.current.begin();
      // 换源同换集：立刻停旧流，拿到新地址前不切画面。
      haltCurrentPlayback();
      // 换源是最终意图：清掉换集乐观态与排队意图，显示收敛到即将落地的目标。
      dispatch({ type: "cancel" });
      switchQueueRef.current?.cancelPending();
      d.setShowSources(false);
      markPhase("preparing");
      d.setSwitchTip(`正在切换到「${option.siteName}」…`);

      let nextLines: PlayLine[] = [];
      let matched: ReturnType<typeof pickMatchingEpisode> | null = null;
      try {
        const list = await api.detail(option.siteKey, option.vodId);
        nextLines = list && list[0]
          ? parsePlayLines(list[0].vod_play_from, list[0].vod_play_url)
          : [];
        matched = pickMatchingEpisode(nextLines, {
          name: current.lines[current.lineIndex]?.episodes[current.episodeIndex]?.name ?? episodeName,
          index: current.episodeIndex,
        });
      } catch (err) {
        // 手动意图已失败收口：立刻释放持有，让自愈不必等满 60s。
        manualHoldRef.current.release();
        d.setSwitchTip("");
        markPhase("idle");
        notify.error(`换源失败：${errorMessage(err)}`);
        return;
      }
      const match = matched;
      if (!match) {
        manualHoldRef.current.release();
        d.setSwitchTip("");
        markPhase("idle");
        notify.error("该源没有可播放剧集，请换一个片源");
        return;
      }
      if (!switchToken.current.isCurrent(gen)) {
        return;
      }

      const lineIndex = Math.max(0, nextLines.indexOf(match.line));
      const nextVodName = option.vodName || current.vodName;
      const nextTarget: PlaybackTarget = {
        siteKey: option.siteKey,
        siteName: option.siteName,
        vodId: option.vodId,
        vodName: nextVodName,
        lines: nextLines,
        lineIndex,
        episodeIndex: match.index,
      };
      dispatch({ type: "intent", target: nextTarget });
      // 面板线路立即跟到新源：display 已换新源 lines，panelLine 若仍是旧索引
      // 会越界（面板显示空或错线）。落地 commit 时再写一次，幂等。
      setPanelLineState(lineIndex);
      log.info("manual source switch", {
        from: current.siteKey,
        to: option.siteKey,
        vodId: option.vodId,
        episode: match.episode.name,
      });
      d.flushHistoryRef.current?.();

      const fallback = () => {
        d.setSwitchTip("");
        videoRef.current = null;
        d.navigate(
          playerRoute({
            siteKey: option.siteKey,
            vodId: option.vodId,
            vodName: nextVodName,
            playUrl: match.episode.url,
            episodeName: match.episode.name,
            playFrom: match.line.name,
          }),
          true,
        );
      };

      if (!d.resolved) {
        fallback();
        return;
      }
      const previousKind = d.resolved.kind;
      try {
        const play = await resolveEpisodePlay(
          option.siteKey,
          match.line.name,
          match.episode.url,
          previousKind,
        );
        await applySwitch(
          gen,
          play,
          { siteKey: option.siteKey, playFrom: match.line.name, url: match.episode.url },
          nextTarget,
        );
        // 内部线路索引随整份 target 落地，panel 天然跟随，这里只是让面板
        // 在落地前也不会停在越界的旧索引上。
        setPanelLineState(lineIndex);
        d.setSwitchTip("");
      } catch (err) {
        invalidateEpisodePlayCache(option.siteKey, match.line.name, match.episode.url);
        log.warn("in-place source switch failed", { message: errorMessage(err) });
        if (switchToken.current.isCurrent(gen)) {
          fallback();
        }
      }
    },
    [applySwitch, episodeName, haltCurrentPlayback, markPhase, videoRef],
  );

  /** 相对跳集（下一集/自动接）：以已落地集为基线，连点只 +1、不越界。 */
  const goEpisode = useCallback(
    (delta: number) => {
      const c = committedRef.current;
      const line = c.lines[c.lineIndex];
      if (!line) {
        return;
      }
      const target = c.episodeIndex + delta;
      if (target < 0 || target >= line.episodes.length) {
        return;
      }
      selectEpisode(c.lineIndex, target);
    },
    [selectEpisode],
  );

  const probeCandidate = useCallback(
    async (
      key: string,
      candidate: { line: string; url: string },
      signal: AbortSignal,
    ): Promise<boolean> => {
      try {
        const target = await resolveEpisodeTarget(key, candidate.line, candidate.url);
        if (target.unresolvable || signal.aborted) {
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
        const ok = await probePlayable(probe.proxyUrl, probe.kind);
        if (ok) {
          setEpisodePlayCache(key, candidate.line, candidate.url, probe);
        }
        return ok;
      } catch {
        return false;
      }
    },
    [],
  );

  /** 自动换线：同源同集 → 同源其它集；找到即 navigate 重建。 */
  const tryNextLine = useCallback(async (): Promise<boolean> => {
    const inflight = depsRef.current.lineAttempt.current;
    if (inflight) {
      return inflight;
    }
    const d = depsRef.current;
    d.lineSwitchStarted.current = true;
    const attempt = (async (): Promise<boolean> => {
      const { gen, signal } = switchToken.current.begin();
      const c = committedRef.current;
      // 记「真正在播的地址」而非路由 raw playUrl：原地换集后路由不变，
      // 用旧值记账本会让刚失败的新集不在账本里，probe 又把它当候选选回来。
      ledgerMarkUrl(d.ledgerKey, playingEpisodeRef.current.url || d.playUrl);

      type Candidate = { line: string; episode: { name: string; url: string } };
      let episodes: Candidate[] = c.lines.flatMap((line) =>
        line.episodes.map((episode) => ({ line: line.name, episode })),
      );
      if (episodes.length === 0) {
        try {
          const detail = await api.detail(c.siteKey, c.vodId);
          const first = detail[0];
          if (first) {
            episodes = parsePlayLines(first.vod_play_from, first.vod_play_url).flatMap(
              (line) => line.episodes.map((episode) => ({ line: line.name, episode })),
            );
          }
        } catch {
          // 详情拿不到就直接走跨站换源。
        }
      }

      const currentEpisodeName =
        c.lines[c.lineIndex]?.episodes[c.episodeIndex]?.name ?? d.episodeName;
      const usable = episodes
        .filter(
          ({ episode }) => Boolean(episode.url) && !ledgerHasUrl(d.ledgerKey, episode.url),
        )
        .map(({ line, episode }) => ({
          line,
          name: episode.name,
          url: episode.url,
          sameEpisode: sameEpisodeName(episode.name, currentEpisodeName),
        }))
        .sort((a, b) => {
          if (a.sameEpisode !== b.sameEpisode) {
            return Number(b.sameEpisode) - Number(a.sameEpisode);
          }
          return lineRank(c.siteKey, a.line) - lineRank(c.siteKey, b.line);
        });

      const sameEpisodeList = usable.filter((item) => item.sameEpisode).slice(0, 12);
      const otherEpisodes = usable.filter((item) => !item.sameEpisode).slice(0, 8);
      const probe = (item: { line: string; url: string }, sig: AbortSignal) =>
        probeCandidate(c.siteKey, item, sig);

      d.setSwitchTip("正在尝试同源的其它线路…");
      let picked = sameEpisodeList.length
        ? await firstPlayable(sameEpisodeList, probe, { concurrency: 4, signal })
        : null;
      if (!picked && otherEpisodes.length) {
        d.setSwitchTip("当前源没有同集可播线路，正在尝试其它集…");
        picked = await firstPlayable(otherEpisodes, probe, { concurrency: 4, signal });
      }
      if (!picked) {
        return false;
      }
      if (!switchToken.current.isCurrent(gen)) {
        return false;
      }
      ledgerMarkUrl(d.ledgerKey, picked.url);
      ledgerCountSwitch(d.ledgerKey);
      markAutoNav();
      d.setSwitchTip(`已自动切换到可播放线路「${picked.name}」`);
      videoRef.current = null;
      d.navigate(
        playerRoute({
          siteKey: c.siteKey,
          vodId: c.vodId,
          vodName: c.vodName,
          episodeName: picked.name,
          playUrl: picked.url,
          playFrom: picked.line,
          failoverKey: d.ledgerKey,
        }),
        true,
      );
      return true;
    })();

    d.lineAttempt.current = attempt;
    try {
      return await attempt;
    } finally {
      d.lineSwitchStarted.current = false;
      if (d.lineAttempt.current === attempt) {
        d.lineAttempt.current = null;
      }
    }
  }, [probeCandidate, videoRef]);

  /** 自动跨站换源：整站找同名影片，逐个探活，首个 200 的 navigate 过去。 */
  const tryFailover = useCallback(async () => {
    const d = depsRef.current;
    if (d.failoverStarted.current) {
      return;
    }
    d.failoverStarted.current = true;
    // 闩锁只防「同一轮自愈被 watchdog 高频重入」，不能一次失败就永久封死。
    // 去重真源是 ledger（ledgerSiteSeen/ledgerBudget 已记录试过的源），所以
    // 除成功 navigate 外的所有出口都释放闩锁，让下一个 watchdog 周期能换批源
    // 再试——否则无候选时不 navigate、闩锁恒 true，后续自愈全被静默吞掉。
    let navigated = false;
    const { gen, signal } = switchToken.current.begin();
    markPhase("idle");
    if (!d.allowFailover) {
      d.setSwitchTip("");
      d.setVideoError("该源不允许换源，请手动切换播放线路或稍后重试。");
      d.failoverStarted.current = false;
      return;
    }
    const c = committedRef.current;
    const name = c.vodName.trim();
    if (!name) {
      d.failoverStarted.current = false;
      return;
    }
    d.setSwitchTip("当前源无法播放，正在寻找其它可用源…");
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
        .filter((item) => !ledgerSiteSeen(d.ledgerKey, item.siteKey));

      for (const candidate of candidates.slice(0, 8)) {
        ledgerMarkSite(d.ledgerKey, candidate.siteKey);
        try {
          const detail = await api.detail(candidate.siteKey, String(candidate.vod.vod_id));
          const first = detail[0];
          if (!first) {
            continue;
          }
          const nextLines = parsePlayLines(first.vod_play_from, first.vod_play_url);
          const currentEpisodeName =
            c.lines[c.lineIndex]?.episodes[c.episodeIndex]?.name ?? d.episodeName;
          const ordered = nextLines
            .flatMap((line) =>
              line.episodes.map((episode) => ({ line: line.name, episode })),
            )
            .sort((a, b) => {
              const sameEpisode =
                Number(b.episode.name === currentEpisodeName) -
                Number(a.episode.name === currentEpisodeName);
              if (sameEpisode !== 0) {
                return sameEpisode;
              }
              return (
                lineRank(candidate.siteKey, a.line) - lineRank(candidate.siteKey, b.line)
              );
            });
          const candidatesOfSite = ordered
            .filter(
              ({ episode }) =>
                Boolean(episode.url) && !ledgerHasUrl(d.ledgerKey, episode.url),
            )
            .slice(0, 8)
            .map(({ line, episode }) => ({ line, name: episode.name, url: episode.url }));
          const picked = await firstPlayable(
            candidatesOfSite,
            (item, sig) => probeCandidate(candidate.siteKey, item, sig),
            { concurrency: 4, signal },
          );
          if (!picked) {
            continue;
          }
          if (!switchToken.current.isCurrent(gen)) {
            return;
          }
          const tip = `已自动切换到「${candidate.siteKey}」`;
          log.info("auto failover", {
            from: c.siteKey,
            to: candidate.siteKey,
            vodId: String(candidate.vod.vod_id),
          });
          window.sessionStorage.setItem("luma:autoSwitch", tip);
          d.setSwitchTip(tip);
          ledgerMarkUrl(d.ledgerKey, picked.url);
          ledgerCountSwitch(d.ledgerKey);
          videoRef.current = null;
          navigated = true;
          d.navigate(
            playerRoute({
              siteKey: candidate.siteKey,
              vodId: String(candidate.vod.vod_id),
              vodName: candidate.vod.vod_name || first.vod_name || name,
              episodeName: picked.name,
              playUrl: picked.url,
              playFrom: picked.line,
              failoverKey: d.ledgerKey,
            }),
            true,
          );
          return;
        } catch {
          continue;
        }
      }
      d.setSwitchTip("");
      d.setVideoError(`所有源都无法播放该影片，${PLAY_FAILURE_HINT}。`);
    } catch (err) {
      d.setSwitchTip("");
      d.setVideoError(`换源失败：${errorMessage(err)}`);
    } finally {
      // 成功 navigate 后页面即将卸载，保持闩锁无所谓；留在本页则释放，
      // 让后续 watchdog 换批源重试（已试源由 ledger 去重，不会搜索风暴）。
      if (!navigated) {
        d.failoverStarted.current = false;
      }
    }
  }, [markPhase, probeCandidate, videoRef]);

  /** 自愈总线：线路失败时先换线、再换源；手动意图持有期内让位。 */
  const switchOrFailover = useCallback(async () => {
    const d = depsRef.current;
    if (manualHoldRef.current.active()) {
      log.info("auto failover deferred", {
        reason: "manual switch in flight",
        ledgerKey: d.ledgerKey,
      });
      return;
    }
    const playing = playingEpisodeRef.current;
    invalidateEpisodePlayCache(playing.siteKey, playing.playFrom, playing.url);
    if (ledgerBudget(d.ledgerKey) <= 0) {
      d.setSwitchTip("");
      d.setVideoError("已自动尝试多条线路和多个源仍无法播放，请手动切换线路或换一集。");
      return;
    }
    const switched = await tryNextLine();
    if (!switched) {
      d.setSwitchTip("当前源没有可播线路，正在尝试其它源…");
      await tryFailover();
    }
  }, [tryFailover, tryNextLine]);
  switchOrFailoverRef.current = switchOrFailover;

  /** 面板「换下一条线路」：与自动换线同通道，但由用户触发。 */
  const nextLine = useCallback(() => {
    if (nextLineBusy) {
      return;
    }
    const d = depsRef.current;
    setNextLineBusy(true);
    manualHoldRef.current.engage(MANUAL_HOLD_MS);
    // 手动换线也会 navigate 重建：先停旧流，避免切换期间继续出声。
    haltCurrentPlayback();
    markPhase("idle");
    d.setSwitchTip("正在切换到下一条线路…");
    void tryNextLine()
      .then((switched) => {
        if (!switched) {
          // 换线失败、留在本页：立即释放手动持有，让自愈无需等满 60s
          // （与 switchSource 失败出口同约定；成功 navigate 则页面重建无所谓）。
          manualHoldRef.current.release();
          d.setSwitchTip("");
          d.setVideoError("当前源没有其它可播线路了，可以换一个源或稍后重试。");
        }
      })
      .catch(() => {
        manualHoldRef.current.release();
        d.setSwitchTip("");
      })
      .finally(() => setNextLineBusy(false));
  }, [haltCurrentPlayback, markPhase, nextLineBusy, tryNextLine]);

  return {
    display,
    committed,
    lines: display.lines,
    vod,
    panelLine,
    setPanelLine,
    phase,
    switching: phase !== "idle",
    canPlayNext,
    nextLineBusy,
    switchedUrlRef,
    playingEpisodeRef,
    switchOrFailoverRef,
    selectEpisode,
    goEpisode,
    switchSource,
    nextLine,
  };
}
