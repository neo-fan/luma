import { useCallback, useEffect, useRef, useState } from "react";
import {
  AUTO_SKIP_COUNTDOWN_S,
  shouldAutoSkipPrompt,
  type SkipKind,
} from "../lib/skipSegments";
import type { SkipWindowState } from "./usePlayerEngine";

/** 正在倒计时的自动跳过：`kind` + 剩余秒数（用于 UI 显示倒计时数字）。 */
export interface AutoSkipPending {
  kind: SkipKind;
  remaining: number;
}

/**
 * 配置片头/片尾后的**自动跳过**：进入窗口不瞬移，而是给 `AUTO_SKIP_COUNTDOWN_S`
 * 秒可取消的倒计时，到点才触发 `onTrigger`（由调用方执行真正的 seek）。
 *
 * 触发时机用 `shouldAutoSkipPrompt` 对「上一次 / 这一次」窗口态做**边沿判定**，纯函数、
 * 无副作用；本 hook 只负责那台一次性倒计时与取消态。
 * - `mediaKey` 变化（换集 / 换源 / 换线路重建媒体）→ 复位边沿基准与倒计时，新片头重新生效。
 * - `skipState` 只在窗口翻转时被引擎上报，所以倒计时途中不会被无关帧打断。
 */
export function useAutoSkipPrompt(
  skipState: SkipWindowState | null,
  mediaKey: string,
  onTrigger: (kind: SkipKind) => void,
): { pending: AutoSkipPending | null; cancel: () => void } {
  const [pending, setPending] = useState<AutoSkipPending | null>(null);
  const prevRef = useRef<SkipWindowState | null>(null);
  const timerRef = useRef<number | null>(null);
  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const kind = shouldAutoSkipPrompt(prevRef.current, skipState);
    prevRef.current = skipState;
    if (!kind) {
      // 窗口态没有「新进入」：撤掉任何在跑的倒计时（例如自动跳途中用户自己划走了窗口）。
      stop();
      return;
    }
    stop();
    let remaining = AUTO_SKIP_COUNTDOWN_S;
    setPending({ kind, remaining });
    timerRef.current = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        stop();
        setPending(null);
        onTriggerRef.current(kind);
      } else {
        setPending({ kind, remaining });
      }
    }, 1000);
  }, [skipState, stop]);

  // 媒体身份变化：把边沿基准清零（新片头重新算一次「进入窗口」），并停掉旧倒计时。
  useEffect(() => {
    stop();
    prevRef.current = null;
    setPending(null);
  }, [mediaKey, stop]);

  // 卸载兜底。
  useEffect(() => stop, [stop]);

  const cancel = useCallback(() => {
    // 只取消本次：prev 已是「在窗口内」，引擎要到用户真正划出窗口才会再报翻转，
    // 因此取消后不会立刻重弹；下次重新进入窗口视为新的一次提示。
    stop();
    setPending(null);
  }, [stop]);

  return { pending, cancel };
}
