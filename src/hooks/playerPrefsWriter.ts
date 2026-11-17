/**
 * 播放偏好写入（2.0.0 从 `usePlayerEngine` 抽出）。
 *
 * `volumechange` / `ratechange` 这两个事件**不只有用户在动**：ArtPlayer 在初始化
 * 与 `switchUrl` 之后会把自己缓存的音量 / 倍速写回元素上（音量被冲成 100%、倍速被
 * 冲成 1）。直接落盘会永久毁掉用户偏好，所以这台负责四件事：
 *
 * 1. **静默期**（新实例 load 后 2s）：期间的变更一律不当作用户操作，不落盘，
 *    并且**即时纠正**回记忆值——否则「切集后前 1.2s 是 1 倍速、随后突然加速」，
 *    而卸载补写又会把 100% 音量固化成偏好；
 * 2. **淡入静默窗**（由 `fader.silentUntil` 提供）：ramp 期间的中间值是淡入自己
 *    写的，整段不落盘。但**淡入还没开始不拦**——自动播放被拦时用户可能先拖音量，
 *    曾用 `!fadeDone` 一并吞掉，偏好永远丢（2026-11-16 实测）；
 * 3. **节流**：拖动音量会连发 `volumechange`，做前缘节流 + trailing 补写，
 *    否则「拖完音量马上切集」会丢最终值；倍速是手动点档的低频事件，立即落盘；
 * 4. **字段隔离**：音量事件绝不写 `rate`、倍速事件绝不写 `volume`——否则拖音量时
 *    若 `playbackRate` 尚未就绪就会把 rate 写坏。
 *
 * 所有回调都要过 `isCurrent()`：切集 / 换源前置空引用后，旧 `<video>` 销毁触发的
 * 变更（已失格）不允许覆盖当前偏好。
 */

/** 写入器要能纠正 ArtPlayer 的噪声回写，所以三个字段都可写（真实 `<video>` 也是如此）。 */
export interface PrefsVideoView {
  volume: number;
  muted: boolean;
  playbackRate: number;
}

export interface PrefsSnapshot {
  volume: number;
  rate: number;
  muted: boolean;
}

export interface PrefsFaderView {
  /** 淡入静默窗截止时刻（epoch ms）。 */
  readonly silentUntil: number;
  /** 最近一次「有声」的音量。 */
  readonly lastAudible: number;
  noteAudible: (volume: number) => void;
}

export interface PrefsWriterOptions {
  video: PrefsVideoView;
  isCurrent: () => boolean;
  fader: PrefsFaderView;
  read: () => PrefsSnapshot;
  write: (patch: Partial<PrefsSnapshot>) => void;
  /** 新实例的静默期长度（默认 2000ms）。原地换集**不**续这个窗。 */
  silenceMs?: number;
  /** 音量节流窗口（默认 500ms）。 */
  throttleMs?: number;
  /** ArtPlayer 初始化覆盖的回正时机（默认 1200ms）。 */
  replayMs?: number;
  now?: () => number;
  timer?: (callback: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

export interface PrefsWriter {
  /** 绑到 `volumechange`。 */
  onVolumeChange: () => void;
  /** 绑到 `ratechange`。 */
  onRateChange: () => void;
  /** 摘掉挂起的定时器（监听由调用方负责解绑）。 */
  dispose: () => void;
}

/** 小于这个差值视为「同一个值」，避免浮点抖动引发回写风暴。 */
const EPSILON = 0.01;
/** 低于这个音量视同静音。 */
const AUDIBLE_FLOOR = 0.01;

export function createPrefsWriter(options: PrefsWriterOptions): PrefsWriter {
  const { video, isCurrent, fader, read, write } = options;
  const now = options.now ?? (() => Date.now());
  const timer = options.timer ?? ((cb, ms) => window.setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle));
  const silenceMs = options.silenceMs ?? 2000;
  const throttleMs = options.throttleMs ?? 500;
  const replayMs = options.replayMs ?? 1200;

  let silenceUntil = now() + silenceMs;
  let volumeWrittenAt = 0;
  let trailing: number | null = null;

  /**
   * 静默期内的噪声纠正。**按事件各自纠正**：音量事件只碰 volume、倍速事件只碰
   * rate —— 与原实现一致，也是文件头第 4 条的字段隔离（一次「顺手」的双字段回写
   * 就可能把尚未就绪的 playbackRate 写成偏好）。
   */
  const correctVolume = () => {
    const wanted = read().volume;
    if (Math.abs(video.volume - wanted) > EPSILON) {
      video.volume = wanted;
    }
  };
  const correctRate = () => {
    const wanted = read().rate;
    if (Math.abs(video.playbackRate - wanted) > EPSILON) {
      video.playbackRate = wanted;
    }
  };

  const replay = timer(() => {
    if (!isCurrent()) {
      return;
    }
    // ArtPlayer 的倍速与音量恢复都晚于构造参数：到点各按自己的字段对一次。
    // 静默期内用户没动，就一定是噪声。
    correctVolume();
    correctRate();
  }, replayMs);

  const onVolumeChange = () => {
    if (!isCurrent()) {
      return;
    }
    // 淡入 ramp 期间整段不落盘（见文件头第 2 条）。
    if (now() < fader.silentUntil) {
      return;
    }
    if (now() < silenceUntil) {
      correctVolume();
      return;
    }
    // 用户点音量图标从静音恢复时，元素音量可能还停在 0（ArtPlayer 只切 muted、
    // 不还原音量）：恢复到最近一次有声值，否则图标亮了还是没声。
    if (!video.muted && video.volume <= AUDIBLE_FLOOR) {
      video.volume = fader.lastAudible;
      return;
    }
    if (!video.muted && video.volume > AUDIBLE_FLOOR) {
      fader.noteAudible(video.volume);
    }
    const at = now();
    if (at - volumeWrittenAt < throttleMs) {
      if (trailing !== null) {
        clearTimer(trailing);
      }
      trailing = timer(() => {
        trailing = null;
        if (!isCurrent()) {
          return;
        }
        volumeWrittenAt = now();
        write({ volume: video.volume, muted: video.muted });
      }, throttleMs);
      return;
    }
    volumeWrittenAt = at;
    write({ volume: video.volume, muted: video.muted });
  };

  const onRateChange = () => {
    if (!isCurrent()) {
      return;
    }
    if (now() < silenceUntil) {
      correctRate();
      return;
    }
    write({ rate: video.playbackRate });
  };

  return {
    onVolumeChange,
    onRateChange,
    dispose: () => {
      if (trailing !== null) {
        clearTimer(trailing);
        trailing = null;
      }
      clearTimer(replay);
      // 让静默期在卸载后立刻失效：避免任何迟到回调误判为「还在窗内」。
      silenceUntil = 0;
    },
  };
}
