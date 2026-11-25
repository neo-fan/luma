import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  AUTO_SKIP_COUNTDOWN_S,
  countdownSeconds,
  pendingStillValid,
  shouldSkipIntro,
  shouldSkipOutro,
  type SkipKind,
} from "../lib/skipSegments";

/** 正在倒计时的自动跳过：`kind` + 剩余秒数（用于 UI 显示倒计时数字）。 */
export interface AutoSkipPending {
  kind: SkipKind;
  remaining: number;
}

/** 倒计时刷新粒度：只影响数字变化与到点精度，不必每帧。 */
const TICK_MS = 200;

interface Options {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** 媒体身份（站点:剧:线路:集）。换集/换源即复位，新一集的片头重新算一次。 */
  mediaKey: string;
  /** 播放器实例的挂载信号（页面的 `playerRoot`）：实例重建时重新挂监听。 */
  attachSignal: unknown;
  /** 这部剧的「跳过」开关。关掉只停跳转，不进任何倒计时。 */
  enabled: boolean;
  introMs: number;
  outroMs: number;
  onTrigger: (kind: SkipKind) => void;
}

/**
 * 片头/片尾的自动跳过：**从播放器事件出发**，不看「窗口态有没有翻转」。
 *
 * 为什么不用边沿判定：窗口态由引擎在翻转时上报，而换集时「新一集的窗口态」
 * 可能早于/晚于渲染到达，边沿的基准很容易停在上一集那条状态上（两集都在片头里
 * 时 `true → true` 不构成边沿），结果整集不跳——实测第 34、35 集反复复现。
 *
 * 现在的判断只有一个问题：**这一集此刻播到哪儿了**。
 * - `playing` / `timeupdate` 时读 `<video>` 的 `currentTime` 与 `duration`：
 *   落在片头窗口且本集还没提示过 → 起 5 秒倒计时；
 *   落在片尾窗口且本集还没提示过 → 起倒计时（`timeupdate` 覆盖「拖进片尾」）。
 * - 每集各记一份「提示过没有」，所以缓冲结束重播 `playing` 也不会重复提示；
 *   用户取消后本集不再打扰。
 * - 倒计时期间暂停会冻结（deadline 顺延），恢复播放后接着剩余秒数。
 */
export function useAutoSkipPrompt({
  videoRef,
  mediaKey,
  attachSignal,
  enabled,
  introMs,
  outroMs,
  onTrigger,
}: Options): { pending: AutoSkipPending | null; cancel: () => void; skipNow: () => void } {
  const [pending, setPending] = useState<AutoSkipPending | null>(null);
  const pendingRef = useRef<AutoSkipPending | null>(null);
  const deadlineRef = useRef(0);
  const lastTickRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;
  /** 本集已经提示过的类型：不进倒计时，也不再重复提示。 */
  const doneRef = useRef<{ intro: boolean; outro: boolean }>({ intro: false, outro: false });

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
    (kind: SkipKind, video: HTMLVideoElement) => {
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
        // 每拍核对播放头是否还在窗口内：续播 seek 落位、缓冲期间用户拖动、
        // HLS 重建重置 currentTime，这些都不保证有 timeupdate / playing 事件。
        // 只靠事件撤销会留下「播到一半还挂着跳过片头」（实测第 03 集）。
        const curMs = video.currentTime * 1000;
        const durMs = Number.isFinite(video.duration) ? video.duration * 1000 : 0;
        if (!pendingStillValid(kind, curMs, durMs, introMs, outroMs)) {
          cancel();
          return;
        }
        if (video.paused) {
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
    [cancel, clearTimer, commit, introMs, outroMs],
  );

  // 换集 / 换源 / 实例重建：本集的「提示过没有」清零，旧倒计时收掉。
  useEffect(() => {
    doneRef.current = { intro: false, outro: false };
    cancel();
  }, [mediaKey, attachSignal, cancel]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !enabled || (introMs <= 0 && outroMs <= 0)) {
      return;
    }
    const check = () => {
      const curMs = video.currentTime * 1000;
      const durMs = Number.isFinite(video.duration) ? video.duration * 1000 : 0;
      const pendingKind = pendingRef.current?.kind;
      if (pendingKind) {
        // 倒计时还在跑，但播放头已经不在那个窗口里了——典型是用户自己拖动
        // 了进度条。此时必须撤掉倒计时，否则 5 秒后会把用户拽回片头/片尾。
        if (!pendingStillValid(pendingKind, curMs, durMs, introMs, outroMs)) {
          cancel();
        }
        return;
      }
      // 暂停 / 还没出画时不起跑：截图里 loading 状态挂着一个冻结在 5 秒的
      // 「跳过片头」，而画面根本没开始播。等 playing 事件（真的出画）再判。
      if (video.paused || video.readyState < 2) {
        return;
      }
      if (!doneRef.current.intro && shouldSkipIntro(curMs, introMs)) {
        doneRef.current.intro = true;
        start("intro", video);
        return;
      }
      if (!doneRef.current.outro && shouldSkipOutro(curMs, durMs, outroMs)) {
        doneRef.current.outro = true;
        start("outro", video);
      }
    };
    video.addEventListener("playing", check);
    video.addEventListener("timeupdate", check);
    // 重新挂监听时可能已经在播（换实例 / HMR），先判一次。
    check();
    return () => {
      video.removeEventListener("playing", check);
      video.removeEventListener("timeupdate", check);
    };
  }, [videoRef, attachSignal, enabled, introMs, outroMs, start]);

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