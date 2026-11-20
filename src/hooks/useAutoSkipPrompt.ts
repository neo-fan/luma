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
 * - `isPaused` 为真时冻结倒计时（deadline 顺延）：暂停是「先别动」的明确意图，
 *   不能 3 秒后把用户从暂停里拽走；恢复播放后继续剩余秒数。
 * - `skipNow` 立即执行当前倒计时；手动跳过任一类型前由调用方先 `cancel()`，
 *   否则到点会把用户刚跳到的位置再拉回原窗口。
 */
export function useAutoSkipPrompt(
  skipState: SkipWindowState | null,
  mediaKey: string,
  onTrigger: (kind: SkipKind) => void,
  isPaused: () => boolean = () => false,
): { pending: AutoSkipPending | null; cancel: () => void; skipNow: () => void } {
  const [pending, setPending] = useState<AutoSkipPending | null>(null);
  const prevRef = useRef<SkipWindowState | null>(null);
  const pendingRef = useRef<AutoSkipPending | null>(null);
  const deadlineRef = useRef(0);
  const lastTickRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const onTriggerRef = useRef(onTrigger);
  const pausedRef = useRef(isPaused);
  onTriggerRef.current = onTrigger;
  pausedRef.current = isPaused;

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
      setPending(null);
      onTriggerRef.current(kind);
    },
    [clearTimer],
  );

  const cancel = useCallback(() => {
    clearTimer();
    pendingRef.current = null;
    setPending(null);
  }, [clearTimer]);

  const start = useCallback(
    (kind: SkipKind) => {
      clearTimer();
      const next = { kind, remaining: AUTO_SKIP_COUNTDOWN_S };
      pendingRef.current = next;
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

  useEffect(() => {
    const kind = shouldAutoSkipPrompt(prevRef.current, skipState);
    prevRef.current = skipState;
    if (!kind) {
      // 窗口态没有「新进入」：撤掉任何在跑的倒计时（例如自动跳途中用户自己划走了窗口）。
      cancel();
      return;
    }
    start(kind);
  }, [skipState, start, cancel]);

  // 媒体身份变化：把边沿基准清零（新片头重新算一次「进入窗口」），并停掉旧倒计时。
  useEffect(() => {
    cancel();
    prevRef.current = null;
  }, [mediaKey, cancel]);

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