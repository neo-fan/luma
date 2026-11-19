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
