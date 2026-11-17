/**
 * 起播音量淡入（2.0.0 从 `usePlayerEngine` 抽出）。
 *
 * 两处噪声源：
 * 1. ArtPlayer 初始化时会把音量恢复成它自己缓存的 100%，比我们的偏好早若干帧
 *    生效——首帧就是满音量，换台听起来像「突然响一声」；
 * 2. MSE / HLS 起播首帧本身带一声爆音（解码器灌入时的采样跳变）。
 *
 * 处理：先静音（`muted=true`）并从 0 起播，等真正 `playing` 后用 200ms 淡入到目标
 * 音量。淡入期间的 `volumechange` **不能落盘**（见 `silentUntil`），否则「0」会被
 * 写成用户偏好。
 *
 * 原先这份逻辑在引擎里抄了两遍（新实例的 `fadeInVolume` 与原地换集的 `swFadeIn`），
 * 两遍的差异只在「目标音量取哪里」和「兜底监听的组合」——正是拖音量后换集丢音量
 * （2026-11-16）那类 bug 的产地。这里收成一台，两个入口。
 *
 * 只做**时序与数值**，不读 DOM 选择器：`target` 是结构最小接口，真实
 * `<video>` 直接满足，单测里用假对象即可跑（不需要 jsdom）。
 */

import { DEFAULT_PREFS } from "../lib/playerPrefs";

/** 淡入时长：也是静默窗的基础值（多留 150ms 吞掉 ramp 期间的节流写）。 */
export const FADE_IN_MS = 200;
/** ramp 完成后追加的静默窗：让节流 / trailing 写全部作废，避免把中间值落盘。 */
export const POST_FADE_SILENCE_MS = 400;
/** `playing` 在直播首帧偶尔不触发（源在缓冲态里反复、或已被新实例接管）时的兜底。 */
export const FALLBACK_MS = 1500;
/** 低于这个音量视同静音，不参与「恢复到有声」的判断。 */
const AUDIBLE_FLOOR = 0.01;

/** 只用到这几个成员：真实 `HTMLVideoElement` 结构上满足。 */
export interface FadeTarget {
  volume: number;
  muted: boolean;
  paused: boolean;
  addEventListener: HTMLVideoElement["addEventListener"];
  removeEventListener: HTMLVideoElement["removeEventListener"];
}

export interface VolumeFaderOptions {
  target: FadeTarget;
  /** 实例身份：淡入过程中被换源 / 卸载（`videoRef.current !== video`）就停手。 */
  isCurrent: () => boolean;
  /** 淡入目标从哪来（冷启动读存储偏好）。每次淡入开始时取一次。 */
  readStored: () => { volume: number; muted: boolean };
  /** 写偏好（只有换集淡入完成时需要：把切换前的有效音量正式落盘）。 */
  writePrefs?: (prefs: { volume: number; muted: boolean }) => void;
  /** 时钟与帧调度，单测里替换成假的。 */
  now?: () => number;
  raf?: (callback: () => void) => void;
  timer?: (callback: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

export interface VolumeFader {
  /** 淡入闸门是否已打开（冷启动前为 false；期间任何音量变化都不是用户意图）。 */
  readonly fadeDone: boolean;
  /** 静默窗截止时刻（epoch ms）：`Date.now() < silentUntil` 期间的音量写一律作废。 */
  readonly silentUntil: number;
  /** 最近一次「有声」的音量：从静音恢复时用它，别恢复到 0。 */
  readonly lastAudible: number;
  /** 新实例：静音起播 + `playing`/`canplay`/`timeupdate`/1.5s 兜底 → 淡入到存储偏好。 */
  armColdStart: () => void;
  /**
   * 原地换集：重新走一次淡入，但**目标 = 切换前的有效音量**（不是存储偏好）——
   * 复用冷启动那条会把音量冲成 ArtPlayer 刚恢复的存储值（2026-11-16 实测）。
   * 返回一个撤销函数，调用方（切换句柄回收器）负责在新一轮切换 / 卸载时调。
   */
  armSwitch: (wanted: { volume: number; muted: boolean }) => () => void;
  /** 记录用户听到的音量，供「取消静音恢复到有声」用。 */
  noteAudible: (volume: number) => void;
  /** 摘掉全部监听与定时器。 */
  dispose: () => void;
}

export function createVolumeFader(options: VolumeFaderOptions): VolumeFader {
  const { target, isCurrent, readStored, writePrefs } = options;
  const now = options.now ?? (() => Date.now());
  const raf = options.raf ?? ((cb: () => void) => window.requestAnimationFrame(cb));
  const timer = options.timer ?? ((cb: () => void, ms: number) => window.setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((handle: number) => window.clearTimeout(handle));

  const initial = clampStored(readStored());
  /** 最近一次「有声」的音量；存储值本身就是 0 时退回默认音量，别恢复到哑的。 */
  let lastAudible = initial.volume > AUDIBLE_FLOOR ? initial.volume : DEFAULT_PREFS.volume;
  let fadeDone = false;
  let silentUntil = 0;
  const listeners: Array<{ type: string; handler: EventListener }> = [];
  let fallbackHandle: number | null = null;

  const on = (type: string, handler: EventListener, once = false) => {
    // 必须是 options 对象：`addEventListener(type, fn, true)` 的第三个参数在 DOM
    // 里是 **capture**，不是 once —— 传错会让监听永不自动摘除，冷启动那一轮的淡入
    // 会在换集之后又跑一遍（把音量拉回存储值）。
    target.addEventListener(type, handler, once ? { once: true } : undefined);
    listeners.push({ type, handler });
  };
  const removeListeners = () => {
    for (const { type, handler } of listeners) {
      target.removeEventListener(type, handler);
    }
    listeners.length = 0;
  };

  /**
   * 淡入代次。每次开始新的淡入（含 `armSwitch`）都自增，在途的 ramp 闭包发现
   * 自己过期就停手 —— 否则冷启动那一轮的 `requestAnimationFrame` 闭包会在换集
   * 淡入之后继续把音量往旧目标上写（原内联实现有这个隐患，只是 200ms 内没人换集
   * 才从未暴露）。
   */
  let ramp = 0;

  /**
   * 淡入到 `wanted`。
   *
   * 顺序是踩出来的：**先把静默窗立起来，再动 `muted` / `volume`**。反过来会让
   * `muted=false` 先触发一次 `volumechange`，`persistVolume` 把此刻的 0 当成用户
   * 在调音量写进偏好，整机从此默认静音（2026-11-15 实测）。
   */
  const fadeTo = (wanted: { volume: number; muted: boolean }, onComplete?: () => void) => {
    if (fadeDone || !isCurrent()) {
      return;
    }
    fadeDone = true;
    const generation = ++ramp;
    if (wanted.muted || wanted.volume <= AUDIBLE_FLOOR) {
      // 用户上次是静音（或音量拖到 0）：保持 muted。别把 0 摊成一个「没静音
      // 但没声音」的状态，否则用户点取消静音后仍然是哑的。
      target.volume = wanted.volume;
      target.muted = true;
      return;
    }
    silentUntil = now() + FADE_IN_MS + 150;
    target.volume = 0;
    target.muted = false;
    const startedAt = now();
    const tick = () => {
      if (!isCurrent() || generation !== ramp) {
        return;
      }
      const progress = Math.min(1, (now() - startedAt) / FADE_IN_MS);
      target.volume = wanted.volume * progress;
      if (progress < 1) {
        raf(tick);
      } else if (onComplete) {
        // 渐入完成：再压一段静默窗，让 ramp 期间挂上的节流 / trailing 写全部作废，
        // 并把目标音量正式落盘——否则下一次 ArtPlayer 恢复缓存音量时，存储里
        // 还是被冲掉前的旧值。
        silentUntil = now() + POST_FADE_SILENCE_MS;
        onComplete();
      }
    };
    raf(tick);
  };

  return {
    get fadeDone() {
      return fadeDone;
    },
    get silentUntil() {
      return silentUntil;
    },
    get lastAudible() {
      return lastAudible;
    },
    noteAudible: (volume: number) => {
      if (volume > AUDIBLE_FLOOR) {
        lastAudible = volume;
      }
    },
    armColdStart: () => {
      target.muted = true;
      target.volume = 0;
      const fadeIn = () => fadeTo(clampStored(readStored()));
      on("playing", fadeIn, true);
      // `playing` 在直播首帧偶尔不触发，只靠它会让画面在播、声音永远是 0：
      // 补 `canplay` / 第一个 `timeupdate`，再加 1.5s 定时器兜最后一层。
      const ifPlaying = () => {
        if (!target.paused) {
          fadeIn();
        }
      };
      on("canplay", ifPlaying);
      on("timeupdate", ifPlaying, true);
      fallbackHandle = timer(ifPlaying, FALLBACK_MS);
    },
    armSwitch: (wanted) => {
      const stored = clampStored(wanted);
      // 重置淡入闸门，从静音起播——目标音量由调用方给（切换前的有效音量）。
      // 先让在途 ramp 作废，再动闸门：否则上一轮淡入的帧闭包会继续往旧目标写。
      ramp += 1;
      fadeDone = false;
      target.volume = 0;
      target.muted = true;
      const fadeIn = () => fadeTo(stored, () => writePrefs?.({ volume: stored.volume, muted: stored.muted }));
      on("playing", fadeIn, true);
      const ifPlaying = () => {
        if (!target.paused) {
          fadeIn();
        }
      };
      on("canplay", ifPlaying, true);
      const handle = timer(ifPlaying, FALLBACK_MS);
      return () => {
        removeListeners();
        clearTimer(handle);
      };
    },
    dispose: () => {
      removeListeners();
      if (fallbackHandle !== null) {
        clearTimer(fallbackHandle);
        fallbackHandle = null;
      }
    },
  };
}

/** 存储值可能是脏数据（越界 / NaN），一律钳到 [0,1]。 */
function clampStored(stored: { volume: number; muted: boolean }): { volume: number; muted: boolean } {
  const volume = Number.isFinite(stored.volume) ? Math.min(1, Math.max(0, stored.volume)) : 1;
  return { volume, muted: stored.muted };
}
