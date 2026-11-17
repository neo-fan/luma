/**
 * 播放偏好写入。
 *
 * `volumechange` / `ratechange` 不只有用户在动：ArtPlayer 在初始化与 switchUrl 之后
 * 会把缓存的音量与倍速写回元素，直接落盘会毁掉偏好。本模块负责：
 * 1. 新实例静默期内的变更不落盘，并按字段各自纠正回记忆值；
 * 2. 淡入静默窗（`fader.silentUntil`）内整段不落盘；淡入未开始不拦；
 * 3. 音量拖动做前缘节流 + trailing 补写；倍速低频，立即落盘；
 * 4. 字段隔离：音量事件只写 volume/muted，倍速事件只写 rate。
 *
 * 所有回调都过 `isCurrent()`：已失格的旧元素不得覆盖当前偏好。
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
   * 噪声纠正按事件各自负责：音量事件只碰 volume，倍速事件只碰 rate。
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


    // 静默期内用户没动，就一定是噪声。
    correctVolume();
    correctRate();
  }, replayMs);

  const onVolumeChange = () => {
    if (!isCurrent()) {
      return;
    }
    // 淡入中间值不落盘。
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
