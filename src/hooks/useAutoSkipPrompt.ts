import { useCallback, useEffect, useRef, useState } from "react";
import {
  AUTO_SKIP_COUNTDOWN_S,
  countdownSeconds,
  shouldAutoSkipPrompt,
  type SkipKind,
} from "../lib/skipSegments";
import type { SkipWindowState } from "./usePlayerEngine";

/** 正在倒计时的自动跳过：`kind` + 剩余秒数（用于 UI 显示倒计时数字）。 */
export interface AutoSkipPending {
  kind: SkipKind;
  remaining: number;
}

/** 倒计时刷新粒度：只影响数字变化与到点精度，不必每帧。 */
const TICK_MS = 200;

/**
 * 配置片头/片尾后的**自动跳过**：进入窗口不瞬移，而是给 `AUTO_SKIP_COUNTDOWN_S`
 * 秒可取消的倒计时，到点才触发 `onTrigger`（由调用方执行真正的 seek）。
 *
 * 触发时机用 `shouldAutoSkipPrompt` 对「上一次 / 这一次」窗口态做**边沿判定**，纯函数、
 * 无副作用；本 hook 只负责那台一次性倒计时与取消态。
 * - `mediaKey` 变化（换集 / 换源 / 换线路重建媒体）→ 复位边沿基准与倒计时，新片头重新生效。
 * - `skipState` 只在窗口翻转时被引擎上报，所以倒计时途中不会被无关帧打断。
 * - `isReady` 为假时（新一集还在缓冲、画面没出来）**先不显示**倒计时，等出画再起跑：
 *   否则上一集的静止画面配着新一集的倒计时，看起来就是「跳过片头还是上一集的」。
 * - `isPaused` 为真时冻结倒计时（deadline 顺延）：暂停是「先别动」的明确意图，
 *   不能 5 秒后把用户从暂停里拽走；恢复播放后继续剩余秒数。
 * - `skipNow` 立即执行当前倒计时；手动跳过任一类型前由调用方先 `cancel()`，
 *   否则到点会把用户刚跳到的位置再拉回原窗口。
 */
export function useAutoSkipPrompt(
  skipState: SkipWindowState | null,
  mediaKey: string,
  onTrigger: (kind: SkipKind) => void,
  isPaused: () => boolean = () => false,
  /**
   * 「这一集的画面真的开始播了」——倒计时必须等它为真才起跑。
   *
   * 换集后窗口态在 `loadedmetadata` 就到了（此时才第 1 帧、还在缓冲），
   * 如果立刻显示「5 秒后跳过片头」，用户看到的是**上一集的静止画面**配上
   * 新一集的倒计时，读起来就是「跳过片头还是上一集的」。等新一集出画再显示，
   * 倒计时和它要操作的那一集才是同一个东西。
   */
  isReady: () => boolean = () => true,
): { pending: AutoSkipPending | null; cancel: () => void; skipNow: () => void } {
  const [pending, setPending] = useState<AutoSkipPending | null>(null);
  const prevRef = useRef<SkipWindowState | null>(null);
  const pendingRef = useRef<AutoSkipPending | null>(null);
  const armedRef = useRef<SkipKind | null>(null);
  /**
   * 当前媒体身份：`start` 要记下「这个倒计时属于哪一集」，媒体切换时才分得清
   * 「该收的旧倒计时」和「刚为新媒体起跑、不该被这次切换收掉的倒计时」。
   */
  const keyRef = useRef(mediaKey);
  keyRef.current = mediaKey;
  const pendingKeyRef = useRef<string | null>(null);
  /** 最近一次参与边沿判定的窗口态对象：用来区分「旧媒体那份」与「新媒体刚送到」。 */
  const evaluatedRef = useRef<SkipWindowState | null>(null);
  /** 最近一次拿到的窗口态：媒体切换时要用它重算一次边沿。 */
  const latestStateRef = useRef(skipState);
  latestStateRef.current = skipState;
  const deadlineRef = useRef(0);
  const lastTickRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const onTriggerRef = useRef(onTrigger);
  const pausedRef = useRef(isPaused);
  const readyRef = useRef(isReady);
  onTriggerRef.current = onTrigger;
  pausedRef.current = isPaused;
  readyRef.current = isReady;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const commit = useCallback(
    (kind: SkipKind) => {
      clearTimer();
      pendingRef.current = null;
      pendingKeyRef.current = null;
      setPending(null);
      onTriggerRef.current(kind);
    },
    [clearTimer],
  );

  const cancel = useCallback(() => {
    clearTimer();
    armedRef.current = null;
    pendingRef.current = null;
    pendingKeyRef.current = null;
    setPending(null);
  }, [clearTimer]);

  const start = useCallback(
    (kind: SkipKind) => {
      clearTimer();
      armedRef.current = null;
      const next = { kind, remaining: AUTO_SKIP_COUNTDOWN_S };
      pendingRef.current = next;
      pendingKeyRef.current = keyRef.current;
      deadlineRef.current = Date.now() + AUTO_SKIP_COUNTDOWN_S * 1000;
      lastTickRef.current = Date.now();
      setPending(next);
      timerRef.current = window.setInterval(() => {
        const now = Date.now();
        const elapsed = now - lastTickRef.current;
        lastTickRef.current = now;
        if (pausedRef.current()) {
          // 暂停期间把 deadline 往后推，恢复播放后仍是原来的剩余秒数。
          deadlineRef.current += elapsed;
          return;
        }
        const remaining = countdownSeconds(deadlineRef.current - now);
        if (remaining <= 0) {
          commit(kind);
          return;
        }
        if (remaining !== pendingRef.current?.remaining) {
          const state = { kind, remaining };
          pendingRef.current = state;
          setPending(state);
        }
      }, TICK_MS);
    },
    [clearTimer, commit],
  );

  /** 边沿判定 + 起跑（或待命）。窗口态变化与媒体切换共用同一份逻辑。 */
  const evaluate = useCallback(
    (cur: SkipWindowState | null) => {
      // 同一份窗口态只判一次：媒体切换那条 effect 可能和窗口态那条落在同一次
      // 提交里，重复判定会把刚起跑的倒计时判成「没有新进入」再收掉。
      if (cur === evaluatedRef.current) {
        return;
      }
      evaluatedRef.current = cur;
      const kind = shouldAutoSkipPrompt(prevRef.current, cur);
      prevRef.current = cur;
      if (!kind) {
        // 窗口态没有「新进入」：撤掉任何在跑的倒计时（例如自动跳途中用户自己划走了窗口）。
        cancel();
        return;
      }
      if (readyRef.current()) {
        start(kind);
      } else {
        // 画面还没起来：先记下这一类，等「真的开始播」再显示倒计时。
        armedRef.current = kind;
      }
    },
    [start, cancel],
  );

  // 顺序有意义：媒体身份这条必须排在窗口态之前。
  //
  // 换集后「新一集的窗口态」可能比这次渲染更早送达（都快），也可能更晚。两种时序
  // 都要能触发一次边沿：
  //  - 早到：这一轮提交里两条 effect 都会跑，先清零基准再判定 → 天然是边沿；
  //  - 晚到：这里只清零基准、不动旧媒体那份状态，等新媒体那份来了再判定。
  // 以前两种情况都只 `cancel()`，晚到时旧媒体的 `inIntro=true` 会留在基准里，
  // 新媒体的 `inIntro=true` 就不算「进入片头」——实测第 35 集整集不跳。
  useEffect(() => {
    prevRef.current = null;
    // 已经为新一集起跑的倒计时不能被这次切换收掉；旧媒体的必须收。
    if (pendingKeyRef.current !== mediaKey) {
      cancel();
    }
    const latest = latestStateRef.current;
    // 只有「还没判定过」的那份才是新媒体送来的；旧媒体那份留给它自己的边沿。
    if (latest !== evaluatedRef.current) {
      evaluate(latest);
    }
  }, [mediaKey, evaluate, cancel]);

  useEffect(() => {
    evaluate(skipState);
  }, [skipState, evaluate]);

  // 待命中的自动跳过：轮询「这一集出画了吗」，一到就起跑。
  //
  // 只在 armed 期间开定时器（`pending === null` 且 `armed` 非空时）——播放中是
  // 常态，不该为此常驻一个轮询。
  useEffect(() => {
    if (!armedRef.current) {
      return;
    }
    const timer = window.setInterval(() => {
      const kind = armedRef.current;
      if (!kind) {
        window.clearInterval(timer);
        return;
      }
      if (!readyRef.current()) {
        return;
      }
      window.clearInterval(timer);
      start(kind);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [skipState, start]);

  // 卸载兜底。
  useEffect(() => clearTimer, [clearTimer]);

  const skipNow = useCallback(() => {
    const current = pendingRef.current;
    if (current) {
      commit(current.kind);
    }
  }, [commit]);

  return { pending, cancel, skipNow };
}