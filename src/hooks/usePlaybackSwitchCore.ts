import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import { createCommitGate, createSwitchToken } from "../lib/switchToken";
import type { CommitGate, SwitchToken } from "../lib/switchToken";
import { createSwitchQueue } from "../lib/switchQueue";
import type { SwitchQueue } from "../lib/switchQueue";
import type { EpisodeNavControl } from "./usePlayerEngine";

/** 选集面板里一次点击的目标。 */
export type EpisodePick = { lineIndex: number; episodeIndex: number };

export interface UsePlaybackSwitchCoreOptions {
  /** 控制栏「下一集」的 ref：markSwitching 直接改其 switching 字段，抢先一拍。 */
  episodeNavRef: RefObject<EpisodeNavControl | null>;
  /** 正在播的 <video>：media-alive（loadedmetadata）据此撤「切换中」。 */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** 路由集身份：冷路径 navigate 后新页面接管，作废排队意图与在途探活。 */
  playUrl: string;
  setSwitchTip: Dispatch<SetStateAction<string>>;
}

export interface PlaybackSwitchCore {
  /** 已请求但还没落地的集：乐观显示真源（点击即移动标题/高亮）。 */
  pendingPick: EpisodePick | null;
  setPendingPick: Dispatch<SetStateAction<EpisodePick | null>>;
  /** 原地换集进行中（渲染用：控制栏转圈 / PlayerStage 覆盖层）。 */
  episodeSwitching: boolean;
  /** 「切换中」的同步锁：写入即时生效，挡同一 tick 的连点。 */
  switchingRef: MutableRefObject<boolean>;
  /** 统一改「切换中」：锁 + state + episodeNavRef 镜像一起动，不许分别 set。 */
  markSwitching: (value: boolean) => void;
  /** 切换代次令牌：begin 抢占 / isCurrent 落地校验 / abortCurrent 路由接管。 */
  switchToken: MutableRefObject<SwitchToken>;
  /** 串行提交门：switchSource 只放行最新代次。 */
  commitGate: MutableRefObject<CommitGate>;
  /** 原地换集串行合并队列（cancelPending / request）。 */
  switchQueueRef: MutableRefObject<SwitchQueue<EpisodePick> | null>;
  /** 队列执行器槽位：PlayerPage 在 render 期把最新 runEpisodeSwitch 挂进来。 */
  switchRunRef: MutableRefObject<(pick: EpisodePick) => Promise<void>>;
}

/**
 * 播放切换的**并发核心**（从 PlayerPage 原样搬出，行为零改动）。
 *
 * 这里只管「谁有权落地」：代次令牌（抢占 / 过期丢弃）、串行提交门（切画面
 * 不并发、后完成者赢从机制上不可能）、切换锁（同步 ref + 渲染 state）、
 * 原地换集的合并队列，以及三条兜底 effect（30s 强解、新源出帧撤加载、
 * 路由接管作废在途）。编排（goToEpisode / pickSource / tryNextLine…）仍在
 * 页面层，通过返回的句柄使用同一套收口。
 */
export function usePlaybackSwitchCore({
  episodeNavRef,
  videoRef,
  playUrl,
  setSwitchTip,
}: UsePlaybackSwitchCoreOptions): PlaybackSwitchCore {
  /**
   * 已请求但还没落地的集：面板用它给那一格「排队中」态，`manualPick` 只在切换
   * 成功后移动。两者分开是必须的——原先点击瞬间就改「正在播放」，同地址 no-op
   * 或解析失败时高亮会停在没在播的那一集上。
   */
  const [pendingPick, setPendingPick] = useState<EpisodePick | null>(null);
  /** 串行合并队列：见 `lib/switchQueue`。执行器在下方赋值，避免闭包顺序问题。 */
  const switchRunRef = useRef<(pick: EpisodePick) => Promise<void>>(async () => undefined);
  const switchQueueRef = useRef<SwitchQueue<EpisodePick> | null>(null);
  if (switchQueueRef.current === null) {
    switchQueueRef.current = createSwitchQueue<EpisodePick>({
      equals: (a, b) => a.lineIndex === b.lineIndex && a.episodeIndex === b.episodeIndex,
      run: (pick) => switchRunRef.current(pick),
    });
  }
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
  /**
   * 统一切换代次令牌：原地换集、手动换源、手动/自动换线、自动跨站换源都共用。
   * 每次切换执行体开头 `begin()` 抢占（中止更早的在途、推进代次），任何落地
   * 副作用前比对 `isCurrent(gen)`，过期整段丢弃 —— 这是并发竞争的唯一收口处，
   * 不再各处 `+= 1` 各挡一段。
   */
  const switchToken = useRef<SwitchToken>(createSwitchToken());
  /**
   * 串行提交门：解析可并发，但真正改画面的 `engine.switchSource` 经此排队，
   * 只放行最新代次 —— 杜绝双路切画面（后完成者赢、画面跳回旧集），且保证
   * 「最终落到画面的一定是当前选中的」。
   */
  const commitGate = useRef<CommitGate>(createCommitGate(switchToken.current));
  /** 统一改「切换中」：ref 当场生效（挡重复点击），state 负责渲染，ref 镜像喂控制栏守卫。 */
  const markSwitching = useCallback((value: boolean) => {
    switchingRef.current = value;
    // episodeNavRef 此刻已指向上一轮渲染写入的对象；直接改字段，让控制栏 click
    // 在重渲染之前就读到最新的 switching，而不是等 render 期重新赋值。
    if (episodeNavRef.current) {
      episodeNavRef.current.switching = value;
    }
    setEpisodeSwitching(value);
  }, [episodeNavRef]);
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
      // 推进代次：让这条挂死超 30s 又迟到的协程结果落地前被判过期丢弃。
      switchToken.current.begin();
      switchQueueRef.current?.cancelPending();
      setPendingPick(null);
      markSwitching(false);
      setSwitchTip("");
    }, 30000);
    return () => window.clearTimeout(timer);
  }, [episodeSwitching, markSwitching, setSwitchTip, switchToken]);
  /**
   * 切换「加载中」到新源真正出帧才撤：`switchSource` 换 src 后，新媒体的
   * `loadedmetadata` 才到（旧媒体的早已触发过、不会再触发），据此判定接管画面
   * 完成。拿不到地址 / 播不了时不在此撤，留在当前画面并交错误态。漏事件由上面
   * 的 30s 兜底、playUrl 接管、navigate 重建各自复位。
   */
  useEffect(() => {
    if (!episodeSwitching) {
      return;
    }
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const onMeta = () => {
      markSwitching(false);
    };
    video.addEventListener("loadedmetadata", onMeta);
    return () => video.removeEventListener("loadedmetadata", onMeta);
  }, [episodeSwitching, markSwitching, videoRef]);
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
    // 新页面接管加载态：排队中的意图作废，否则旧集会在重建后又被打回去。
    // 同时中止在途探活：本组件即将交给新路由身份，孤儿解析不该继续。
    switchToken.current.abortCurrent();
    switchQueueRef.current?.cancelPending();
    setPendingPick(null);
    // 仅跟随路由集身份变化触发；markSwitching 恒定，不需要进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playUrl]);

  return {
    pendingPick,
    setPendingPick,
    episodeSwitching,
    switchingRef,
    markSwitching,
    switchToken,
    commitGate,
    switchQueueRef,
    switchRunRef,
  };
}

/* ============================================================
   第 3 期：切换编排层（goToEpisode / 换集执行器 / 换源 / 换线 / 自愈总线）
   ------------------------------------------------------------
   依赖注入：页面先建 switchOrFailoverRef（engine 参数要用，解「编排需要
   engine.switchSource、engine 需要 switchOrFailoverRef」的环），编排 hook
   每渲染把 deps 镜像进 ref —— 回调身份稳定（可进 effect 依赖），读到的
   永远是最新渲染的 activeLines / committed 基线 / resolved。
   ============================================================ */

import {
  ledgerBudget,
  ledgerCountSwitch,
  ledgerHasUrl,
  ledgerMarkSite,
  ledgerMarkUrl,
  ledgerSiteSeen,
  markAutoNav,
} from "../lib/failoverLedger";
import { firstPlayable } from "../lib/probeRace";
import { probePlayable } from "../lib/playProbe";
import { lineRank } from "../lib/lineHealth";
import {
  getEpisodePlayCache,
  invalidateEpisodePlayCache,
  setEpisodePlayCache,
} from "../lib/episodePlayCache";
import { resolveEpisodeTarget } from "../lib/episodeResolve";
import { parsePlayLines, sameEpisodeName } from "../lib/format";
import { pickMatchingEpisode } from "../lib/sources";
import { PLAY_FAILURE_HINT } from "../lib/features";
import { errorMessage, api } from "../lib/invoke";
import { log } from "../lib/logger";
import { notify } from "../lib/notify";
import type { Navigate } from "../lib/nav";
import type { SourceOption } from "../lib/sources";
import type { PlayLine } from "../lib/format";
import type { PlayResolved, ResultPage } from "../types/luma";
import type { UsePlayerEngineHandle } from "./usePlayerEngine";

export interface PlaybackSwitchDeps {
  navigate: Navigate;
  resolved: PlayResolved | null;
  siteKey: string;
  vodId: string;
  vodName: string;
  episodeName: string;
  playUrl: string;
  /** 站点 `changeable: 0` 时禁止跨站自动换源。 */
  allowFailover: boolean;
  ledgerKey: string;
  engine: UsePlayerEngineHandle;
  /** 乐观/committed 派生值随每次渲染注入（回调经 depsRef 读最新）。 */
  activeLines: PlayLine[];
  activeEpisodeIndex: number;
  activeEpisodeName: string;
  committedLine: PlayLine | null;
  committedLineIndex: number;
  committedEpisodeIndex: number;
  lines: PlayLine[];
  /** 核心句柄（与 usePlaybackSwitchCore 返回同一批）。 */
  pendingPick: EpisodePick | null;
  setPendingPick: Dispatch<SetStateAction<EpisodePick | null>>;
  markSwitching: (value: boolean) => void;
  switchToken: MutableRefObject<SwitchToken>;
  commitGate: MutableRefObject<CommitGate>;
  switchQueueRef: MutableRefObject<SwitchQueue<EpisodePick> | null>;
  switchRunRef: MutableRefObject<(pick: EpisodePick) => Promise<void>>;
  switchingRef: MutableRefObject<boolean>;
  /** 原地换源覆盖后的身份（回写 setSwitchedSource 与 fallback navigate 用）。 */
  activeSiteKey: string;
  activeVodId: string;
  activeVodName: string;
  /** 页面侧 setter（身份稳定，直捕获）。 */
  setSwitchTip: Dispatch<SetStateAction<string>>;
  setVideoError: Dispatch<SetStateAction<string>>;
  setSwitchedSource: Dispatch<
    SetStateAction<{
      siteKey: string;
      siteName: string;
      vodId: string;
      vodName: string;
      lines: PlayLine[];
      lineIndex: number;
      episodeIndex: number;
    } | null>
  >;
  setManualPick: Dispatch<SetStateAction<{ lineIndex: number; episodeIndex: number } | null>>;
  setShowSources: Dispatch<SetStateAction<boolean>>;
  /** 数据层句柄（页面已建，稳定引用）。 */
  flushHistoryRef: MutableRefObject<(() => void) | null>;
  resumeMsRef: MutableRefObject<number>;
  /** engine 的换线闸门与去重通道：页面持有、编排写入（跨 hook 共享可变体）。 */
  failoverStarted: MutableRefObject<boolean>;
  lineSwitchStarted: MutableRefObject<boolean>;
  lineAttempt: MutableRefObject<Promise<boolean> | null>;
  /** 页面预建的 engine 兜底总线：编排每渲染把最新结论挂上去。 */
  switchOrFailoverRef: MutableRefObject<() => Promise<void>>;
  videoRef: MutableRefObject<HTMLVideoElement | null>;
}

export interface PlaybackSwitchOrchestration {
  /** 原地换后的真实播放地址（路由 playUrl 不跟改；页面渲染用它清错误条）。 */
  switchedUrlRef: MutableRefObject<string | null>;
  /** 真正在播的集身份：fatal 按它作废解析缓存。 */
  playingEpisodeRef: MutableRefObject<{ siteKey: string; playFrom: string; url: string }>;
  nextLineBusy: boolean;
  goToEpisode: (targetLine: number, index: number) => void;
  goEpisode: (delta: number) => void;
  pickSource: (option: SourceOption) => Promise<void>;
  pickNextLine: () => void;
}

/**
 * 切换编排：选集（乐观 + 队列 + 串行提交）、手动换源、手动/自动换线、
 * 跨站自愈总线。所有页面派生值经 `depsRef` 注入，本 hook 自身零状态泄漏。
 */
export function usePlaybackSwitch(deps: PlaybackSwitchDeps): PlaybackSwitchOrchestration {
  // 每渲染镜像最新 deps；下面的回调身份稳定，读到的永远是最新值。
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const {
    markSwitching,
    setPendingPick,
    switchToken,
    commitGate,
    switchQueueRef,
    switchRunRef,
    switchingRef,
    videoRef,
    failoverStarted,
    lineSwitchStarted,
    lineAttempt,
  } = deps;

  /** 原地换后的真实播放地址（路由里的 playUrl 不跟着改）。 */
  const switchedUrlRef = useRef<string | null>(null);
  /**
   * 当前真正在播的「集身份」（站点 / 线路 / 集地址）。原地换集 / 换源后路由
   * 参数是旧的，播放 fatal 要按这份身份作废解析缓存，否则作废的是上一集。
   */
  const playingEpisodeRef = useRef({ siteKey: "", playFrom: "", url: "" });
  const [nextLineBusy, setNextLineBusy] = useState(false);
  /** 线路切换失败后的兜底总线 ref：engine 参数要用，页面预建、这里每渲染赋值。 */
  const { switchOrFailoverRef } = deps;

  const probeCandidate = useCallback(
    async (
      key: string,
      candidate: { line: string; url: string },
      signal: AbortSignal,
    ): Promise<boolean> => {
      try {
        const target = await resolveEpisodeTarget(key, candidate.line, candidate.url);
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
          // 探活已跑完整条解析链：预热按集缓存，navigate 重挂载后新页面的
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
    const d = depsRef.current;
    if (failoverStarted.current) {
      return;
    }
    failoverStarted.current = true;
    // 换源接管：begin 抢占更早的在途切换（中止其探活、令其 isCurrent 失效），
    // 并收回可能挂着的「换集进行中」，否则控制栏会被钉住到兜底超时。
    const { gen, signal: foSignal } = switchToken.current.begin();
    markSwitching(false);
    // `changeable: 0`：配置明确不允许换源，别再对其它站点发搜索。
    if (!d.allowFailover) {
      d.setSwitchTip("");
      d.setVideoError("该源不允许换源，请手动切换播放线路或稍后重试。");
      return;
    }
    const name = d.vodName.trim();
    if (!name) {
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
                Number(b.episode.name === d.episodeName) -
                Number(a.episode.name === d.episodeName);
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
                Boolean(episode.url) && !ledgerHasUrl(d.ledgerKey, episode.url),
            )
            .slice(0, 8)
            .map(({ line, episode }) => ({ line, name: episode.name, url: episode.url }));
          // 并发探活：第一个能播的立刻返回。串行时「每条失败线路 2–5 秒」会
          // 让用户对着转圈等十几秒，实际只有一条是通的。
          const picked = await firstPlayable(
            candidatesOfSite,
            (item, signal) => probeCandidate(candidate.siteKey, item, signal),
            { concurrency: 4, signal: foSignal },
          );
          if (!picked) {
            continue;
          }
          // 落地前确认仍是最新意图：探活期间被新的换集/换源/换线抢占过就停手。
          if (!switchToken.current.isCurrent(gen)) {
            return;
          }
          const tip = `已自动切换到「${candidate.siteKey}」`;
          log.info("auto failover", {
            from: d.siteKey,
            to: candidate.siteKey,
            vodId: String(candidate.vod.vod_id),
          });
          window.sessionStorage.setItem("luma:autoSwitch", tip);
          d.setSwitchTip(tip);
          ledgerMarkUrl(d.ledgerKey, picked.url);
          ledgerCountSwitch(d.ledgerKey);
          videoRef.current = null;
          d.navigate(
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
              failoverKey: d.ledgerKey,
            },
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
    }
  }, [markSwitching, probeCandidate, switchToken, videoRef]);

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
    const d = depsRef.current;
    const inflight = lineAttempt.current;
    if (inflight) {
      return inflight;
    }
    lineSwitchStarted.current = true;
    const attempt = (async (): Promise<boolean> => {
      // 抢占：开始一次换线即中止更早的在途切换；signal 透传给探活让其真早停。
      const { gen, signal: lineSignal } = switchToken.current.begin();
      ledgerMarkUrl(d.ledgerKey, d.playUrl);

      // 线路名必须跟着每条剧集一起走：`PAN1-…` / `zijianm3u8-…` 这类地址只有
      // 交给对应线路的 playerContent 才能变成直链，脱掉线路名就等于把私有 token
      // 当 URL 解析（实测一次换线路能刷出 11 条 "play url is invalid"，且真正
      // 可播的线路被整条跳过）。
      type Candidate = { line: string; episode: { name: string; url: string } };
      let episodes: Candidate[] = d.lines.flatMap((line) =>
        line.episodes.map((episode) => ({ line: line.name, episode })),
      );
      if (episodes.length === 0) {
        try {
          const detail = await api.detail(d.siteKey, d.vodId);
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
            Boolean(episode.url) && !ledgerHasUrl(d.ledgerKey, episode.url),
        )
        .map(({ line, episode }) => ({
          line,
          name: episode.name,
          url: episode.url,
          sameEpisode: sameEpisodeName(episode.name, d.episodeName),
        }))
        .sort((a, b) => {
          if (a.sameEpisode !== b.sameEpisode) {
            return Number(b.sameEpisode) - Number(a.sameEpisode);
          }
          // 同集的不同线路：把最近解码成功的排前面，判过死 token 的排最后。
          return lineRank(d.siteKey, a.line) - lineRank(d.siteKey, b.line);
        });

      // 阶段一：当前源、当前这一集的不同线路（真正意义上的「换线路」）。
      // 阶段二：当前源的其它集（源把剧集表切错时也能救回来）。
      const sameEpisodeList = usable
        .filter((item) => item.sameEpisode)
        .slice(0, 12);
      const otherEpisodes = usable
        .filter((item) => !item.sameEpisode)
        .slice(0, 8);
      const probe = (item: { line: string; url: string }, signal: AbortSignal) =>
        probeCandidate(d.siteKey, item, signal);

      // 并发探活（首个成功即中止其余）：串行时「布布追剧 → 走马上任」第 3 集要
      // 16 秒才出画，用户以为坏了；现在是最快那条线路的耗时。
      d.setSwitchTip("正在尝试同源的其它线路…");
      let picked = sameEpisodeList.length
        ? await firstPlayable(sameEpisodeList, probe, { concurrency: 4, signal: lineSignal })
        : null;
      if (!picked && otherEpisodes.length) {
        d.setSwitchTip("当前源没有同集可播线路，正在尝试其它集…");
        picked = await firstPlayable(otherEpisodes, probe, { concurrency: 4, signal: lineSignal });
      }
      if (!picked) {
        return false;
      }
      // 落地前确认仍是最新意图：被新的换集/换源抢占过就停手，不拽路由。
      if (!switchToken.current.isCurrent(gen)) {
        return false;
      }
      ledgerMarkUrl(d.ledgerKey, picked.url);
      ledgerCountSwitch(d.ledgerKey);
      markAutoNav();
      d.setSwitchTip(`已自动切换到可播放线路「${picked.name}」`);
      videoRef.current = null;
      d.navigate(
        {
          name: "player",
          siteKey: d.siteKey,
          vodId: d.vodId,
          vodName: d.vodName,
          episodeName: picked.name,
          playUrl: picked.url,
          // 切换后必须保留线路名，否则下一次解析又拿不到 playerContent。
          playFrom: picked.line,
          // 同站换线也透传 key：跳转目标页据此知道不是手动点播，不清账。
          failoverKey: d.ledgerKey,
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
  }, [markSwitching, probeCandidate, switchToken, videoRef]);

  /** 线路切换失败后的兜底：整站找同名影片。 */
  const switchOrFailover = useCallback(async () => {
    const d = depsRef.current;
    // 走到这里说明播放 fatal（hls fatal / 解码失败 / 看门狗判死）：当前地址
    // 的解析结论不可信，作废按集缓存，避免换集 / remount 又命中坏地址。
    // 按「真正在播的集」作废——原地换集后路由参数已是上一集。
    const playing = playingEpisodeRef.current;
    invalidateEpisodePlayCache(playing.siteKey, playing.playFrom, playing.url);
    // 跳转次数预算用完就停：之前没有上限，跨站记账又失效，会出现
    // 「一直在切换」的无限横跳；现在最多 4 次，之后把控制权交还用户。
    if (ledgerBudget(d.ledgerKey) <= 0) {
      d.setSwitchTip("");
      d.setVideoError("已自动尝试多条线路和多个源仍无法播放，请手动切换线路或换一集。");
      return;
    }
    const switched = await tryNextLine();
    if (!switched) {
      // 阶段文案要跟上实际行为：先穷尽同源线路，才轮到跨站换源。
      d.setSwitchTip("当前源没有可播线路，正在尝试其它源…");
      await tryFailover();
    }
  }, [tryFailover, tryNextLine]);

  /** 面板里的「换下一条线路」：和自动换线走同一条通道，但由用户触发、不记账。 */
  const pickNextLine = useCallback(() => {
    const d = depsRef.current;
    if (nextLineBusy) {
      return;
    }
    setNextLineBusy(true);
    // 手动换线接管：收回挂起的「换集进行中」。抢占更早的在途切换交给 tryNextLine
    // 执行体开头的 begin（与自动换线同一通道，这里不重复推进代次）。
    markSwitching(false);
    d.setSwitchTip("正在切换到下一条线路…");
    void tryNextLine()
      .then((switched) => {
        if (!switched) {
          d.setSwitchTip("");
          d.setVideoError("当前源没有其它可播线路了，可以换一个源或稍后重试。");
        }
      })
      .finally(() => setNextLineBusy(false));
  }, [markSwitching, nextLineBusy, tryNextLine]);

  /**
   * 选集面板里点任意线路 / 任意一集。
   *
   * 走串行合并队列：一次只跑一个切换，但切换没回来时点的集**不丢**——它覆盖成
   * 新的 pending，上一次收口后立刻执行。连点 5 集只解析第 1 与第 5 集。
   */
  const goToEpisode = useCallback((targetLine: number, index: number) => {
    const d = depsRef.current;
    const target = d.activeLines[targetLine];
    if (!target || index < 0 || index >= target.episodes.length) {
      return;
    }
    // 防抖：同一目标已在途就忽略。否则这里的 begin() 会把自己正在跑的切换判成
    // 过期，而重复目标又被队列去重不再执行 → 最终没有任何一次落地。
    if (
      switchingRef.current &&
      d.pendingPick?.lineIndex === targetLine &&
      d.pendingPick?.episodeIndex === index
    ) {
      return;
    }
    // 点击即接管：begin 抢占任何在途解析（旧的那份落地前会被判过期丢弃），
    // 同步把乐观高亮 / 标题移到选中集，并进入「加载中」——后台再解析，不挡 UI。
    switchToken.current.begin();
    markSwitching(true);
    setPendingPick({ lineIndex: targetLine, episodeIndex: index });
    d.setSwitchTip(`正在切换到「${target.episodes[index].name}」…`);
    switchQueueRef.current?.request({ lineIndex: targetLine, episodeIndex: index });
  }, [markSwitching, setPendingPick, switchQueueRef, switchToken, switchingRef]);

  /** 队列的执行器：原地换集，失败退回整页 navigate。 */
  const runEpisodeSwitch = useCallback(
    ({ lineIndex: targetLine, episodeIndex: index }: EpisodePick) => {
      const d = depsRef.current;
      const target = d.activeLines[targetLine];
      if (!target || index < 0 || index >= target.episodes.length) {
        return Promise.resolve();
      }
      const episode = target.episodes[index];
      // 立刻上锁并点亮 loading，且在 `!resolved` 分支之前：冷路径直接 navigate
      // 重建，若等到快路径才置真，这一路既不转圈也不挡并发入口。
      // 切换前是不是在播：决定切换后要不要自动续播（由机器据此发起 resumePlayback），
      // 也决定收口文案要不要提示「点播放继续」。
      const wasPlayingBefore = videoRef.current ? !videoRef.current.paused : false;
      markSwitching(true);
      d.flushHistoryRef.current?.();

      const settlePick = () => {
        setPendingPick(null);
      };

      const fallback = () => {
        // 不回收乐观显示：pendingPick 已指向目标集，清掉会让画面瞬间回落旧路由
        // （第一集）。交给 navigate 重建后的新页面接管，这里只清转场锁与提示。
        d.setSwitchTip("");
        videoRef.current = null;
        d.navigate(
          {
            name: "player",
            siteKey: d.activeSiteKey,
            vodId: d.activeVodId,
            vodName: d.activeVodName,
            playUrl: episode.url,
            episodeName: episode.name,
            playFrom: target.name,
          },
          true,
        );
      };

      if (!d.resolved) {
        fallback();
        return Promise.resolve();
      }
      const previousKind = d.resolved.kind;
      // 抢占：本次换集执行开始即中止更早的在途切换，落地副作用前据此判过期。
      const { gen } = switchToken.current.begin();
      return (async () => {
        try {
          // 按集缓存：预解析 / 探活 / 上次访问可能已解析过这一集。命中且类型
          // 兼容就跳过整条 playerContent → resolve_play 链，直接原地换源。
          const cached = getEpisodePlayCache(d.activeSiteKey, target.name, episode.url);
          let play: PlayResolved;
          if (cached && cached.kind === previousKind && cached.kind !== "page") {
            play = cached;
          } else {
            const next = await resolveEpisodeTarget(d.activeSiteKey, target.name, episode.url);
            if (next.unresolvable) {
              throw new Error("线路不可解析");
            }
            play = await api.resolvePlay({
              siteKey: d.activeSiteKey,
              url: next.url,
              ua: next.ua,
              referer: next.referer,
              cookie: next.cookie,
            });
            if (play.kind !== previousKind || play.kind === "page") {
              throw new Error(`播放类型变化：${previousKind} → ${play.kind}`);
            }
            setEpisodePlayCache(d.activeSiteKey, target.name, episode.url, play);
          }
          d.resumeMsRef.current = 0;
          // 串行提交、只最新上屏：解析在锁外并发；进锁后再校验代次，被更新的
          // 换源/换线/换集抢占过就根本不碰画面。锁内一气呵成切画面 + 写集身份。
          await commitGate.current.commit(gen, async () => {
            await d.engine.switchSource(play.proxyUrl);
            switchedUrlRef.current = play.proxyUrl;
            playingEpisodeRef.current = {
              siteKey: d.activeSiteKey,
              playFrom: target.name,
              url: episode.url,
            };
            // 「当前集」高亮落地（乐观态本就是它，这里确认并让 pendingPick 交棒）。
            d.setManualPick({ lineIndex: targetLine, episodeIndex: index });
            settlePick();
            // 切换前是暂停态就不抢控制权自动播；画面停在 0:00 要说明在等什么。
            d.setSwitchTip(
              !wasPlayingBefore ? `已切到「${episode.name}」，点播放继续` : "",
            );
          });
        } catch (err) {
          // 原地切换失败要退回整页重建：这份解析结论（可能来自缓存）已不可信，
          // 作废掉，免得新页面首次解析又命中同一个坏地址。
          invalidateEpisodePlayCache(d.activeSiteKey, target.name, episode.url);
          log.warn("in-place episode switch failed", { message: errorMessage(err) });
          // 已被更新的切换抢占：这份失败不作废页面，交给最新意图处理。
          if (switchToken.current.isCurrent(gen)) {
            fallback();
          }
        }
        // 「切换中」不在此处清：画面已交给新的 <video>，改由 media-alive effect
        // 等新源真正出帧再撤加载动画。冷路径 navigate、30s 兜底、playUrl 接管复位。
      })();
    },
    [commitGate, markSwitching, setPendingPick, switchToken, videoRef],
  );
  // 渲染期把最新执行器交给队列：与 episodeNavRef 同一套路数。
  switchRunRef.current = runEpisodeSwitch;

  const goEpisode = useCallback(
    (delta: number) => {
      const d = depsRef.current;
      if (!d.committedLine) {
        return;
      }
      // 以实时已落地集为基线：连点下一集目标恒为 committed+1（被去重），最后一集
      // 越界直接返回——既「正常 +1」又不跳多集、不过界。
      const target = d.committedEpisodeIndex + delta;
      if (target < 0 || target >= d.committedLine.episodes.length) {
        return;
      }
      goToEpisode(d.committedLineIndex, target);
    },
    [goToEpisode],
  );

  /**
   * 手动换源：用户选定站点后取该站详情，尽量续播同一集（同名 / 同集号 /
   * 同序号），不探活也不抢答——选哪个源由用户决定，失败仍走原有兜底链路。
   */
  const pickSource = useCallback(
    async (option: SourceOption) => {
      const d = depsRef.current;
      // 抢占：手动换源是最强用户意图，begin 立即作废在途的换集/换线/自动恢复。
      const { gen } = switchToken.current.begin();
      d.setShowSources(false);
      // 换源接管：立即进入「切换中」，后台再取详情 + 解析 + 切流；画面转圈走
      // ArtPlayer 原生 loading（由 setLoading effect 驱动），新媒体出帧才收。
      markSwitching(true);
      d.setSwitchTip(`正在切换到「${option.siteName}」…`);
      let matched: ReturnType<typeof pickMatchingEpisode> | null = null;
      let nextLines: PlayLine[] = [];
      try {
        const list = await api.detail(option.siteKey, option.vodId);
        nextLines = list?.[0]
          ? parsePlayLines(list[0].vod_play_from, list[0].vod_play_url)
          : [];
        matched = pickMatchingEpisode(nextLines, {
          name: d.activeEpisodeName,
          index: d.activeEpisodeIndex,
        });
      } catch (err) {
        d.setSwitchTip("");
        notify.error(`换源失败：${errorMessage(err)}`);
        return;
      }
      const match = matched;
      if (!match) {
        d.setSwitchTip("");
        notify.error("该源没有可播放剧集，请换一个片源");
        return;
      }
      // 取详情期间被更新的切换抢占过 → 停手，不继续换源。
      if (!switchToken.current.isCurrent(gen)) {
        return;
      }
      log.info("manual source switch", {
        from: d.activeSiteKey,
        to: option.siteKey,
        vodId: option.vodId,
        episode: d.activeEpisodeName,
      });
      // 换源前先落库：历史按剧名合并，这条进度就是新源的续播起点。
      d.flushHistoryRef.current?.();
      const nextVodName = option.vodName || d.activeVodName;
      const nextSiteKey = option.siteKey;
      // 兜底：新线路解析失败（跨协议 / 还没拿到播放器）才整页重建。
      const fallback = () => {
        d.setSwitchedSource(null);
        d.setSwitchTip("");
        videoRef.current = null;
        d.navigate(
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
      if (!d.resolved) {
        fallback();
        return;
      }
      const previousKind = d.resolved.kind;
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
        d.resumeMsRef.current = 0;
        // 串行提交、只最新上屏：解析在锁外并发，进锁后再校验代次，被更新的换源/
        // 换集抢占过就不碰画面；锁内写画面 + 集身份/信息卡一气呵成。
        await commitGate.current.commit(gen, async () => {
          await d.engine.switchSource(play.proxyUrl);
          switchedUrlRef.current = play.proxyUrl;
          playingEpisodeRef.current = {
            siteKey: nextSiteKey,
            playFrom: match.line.name,
            url: match.episode.url,
          };
          d.setSwitchedSource({
            siteKey: nextSiteKey,
            siteName: option.siteName,
            vodId: option.vodId,
            vodName: nextVodName,
            lines: nextLines,
            lineIndex: Math.max(0, nextLines.indexOf(match.line)),
            episodeIndex: nextLines.indexOf(match.line) >= 0 ? match.index : 0,
          });
          d.setManualPick(null);
          d.setSwitchTip("");
        });
      } catch (err) {
        // 同换集：失败的解析结论（可能来自缓存）作废，重建后的页面重新解析。
        invalidateEpisodePlayCache(nextSiteKey, match.line.name, match.episode.url);
        log.warn("in-place source switch failed", { message: errorMessage(err) });
        if (switchToken.current.isCurrent(gen)) {
          fallback();
        }
      }
    },
    [commitGate, markSwitching, switchToken, videoRef],
  );

  // 渲染期把最新自愈结论挂到页面预建的 ref 上（engine 参数即它）。
  switchOrFailoverRef.current = switchOrFailover;

  return {
    switchedUrlRef,
    playingEpisodeRef,
    nextLineBusy,
    goToEpisode,
    goEpisode,
    pickSource,
    pickNextLine,
  };
}
