/**
 * 播放偏好（音量 / 静音 / 上次清晰度）。
 *
 * 连看 36 集时，每集都把音量重置回默认是最烦的体验问题之一；这里把它们落到
 * localStorage，新一集 / 下一部片都沿用。清晰度只在「同一档位仍存在」时套用，
 * 源站换码率就退回自动，避免硬套一个不存在的档位。
 *
 * **倍速不在这里**：倍速是「看这部剧的习惯」，不是全局习惯——同一晚上看悬疑剧
 * 想 1.5 倍、看综艺想 1 倍是常态。它跟着 history 的那一行（按剧名合并，换源也
 * 带着走），见 `HistoryItem.rate`。
 */

export interface PlayerPrefs {
  /** 0~1。 */
  volume: number;
  /**
   * 用户是否按过静音。单独记：音量 0 有两种含义（拖到 0 / 按了静音），
   * 只有后者点一次音量图标就该恢复，前者得靠用户重新拖。
   */
  muted: boolean;
  /** 上次选中的清晰度高度（如 1080）；缺省表示跟随自动。 */
  height?: number;
}

export const DEFAULT_PREFS: PlayerPrefs = { volume: 0.8, muted: false };

/**
 * 倍速合法区间。虽然倍速本身不再存在这份偏好里，区间仍是播放器的事实：
 * ArtPlayer 菜单只给这几档，按剧记忆的值入库前也要过它。
 */
export const RATE_MIN = 0.5;
export const RATE_MAX = 3;
/** 没设过倍速的剧从这里起播。 */
export const DEFAULT_RATE = 1;

import { PLAYER_PREFS_KEY } from "./storageKeys";

const KEY = PLAYER_PREFS_KEY;

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

/** 音量合法区间；非法值退回默认。0 = 静音，也是有效偏好，要照样记住。 */
export function clampVolume(value: number): number {
  return clamp(value, 0, 1, DEFAULT_PREFS.volume);
}

/**
 * 倍速合法区间。倍速本身已不存在这份全局偏好里（它按剧存在 playback 行上），
 * 但区间仍是播放器的事实：ArtPlayer 菜单只给这几档，入库前也要过一遍。
 *
 * ⚠️ `0` / 负数 = 「这部剧没设过倍速」（`playback.rate` 的默认值），必须当成
 * 没设过 → 1.0。数值钳制会把 0 抬到下限 0.5，等于**所有没设过倍速的剧都以
 * 半速起播**（实测：新装后每部片都是 0.5x）。先判「有没有值」，再钳区间。
 */
export function clampRate(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_RATE;
  }
  return clamp(value, RATE_MIN, RATE_MAX, DEFAULT_RATE);
}

function storageOf(storage?: Storage): Storage | null {
  if (storage) {
    return storage;
  }
  try {
    return window.localStorage;
  } catch {
    // 隐私模式 / 沙箱下访问 localStorage 会抛异常。
    return null;
  }
}

/** 读取偏好；损坏的 JSON 或越界值一律回落到默认值。 */
export function readPlayerPrefs(storage?: Storage): PlayerPrefs {
  const store = storageOf(storage);
  if (!store) {
    return { ...DEFAULT_PREFS };
  }
  try {
    const raw = store.getItem(KEY);
    if (!raw) {
      return { ...DEFAULT_PREFS };
    }
    const parsed = JSON.parse(raw) as Partial<PlayerPrefs>;
    /**
     * 旧格式没有 `muted` 字段。1.0.4 开发期的起播淡入 bug 会把「还没淡入的
     * 0 音量」写成偏好，导致整机从此默认静音——那种 0 没有配套的 muted=true，
     * 直接按损坏数据处理，回落到默认音量。真正拖到 0 的用户会带着 muted 字段
     * （新版本写入）或被修复后的路径重新写入，不受影响。
     */
    const legacyZero = parsed.muted === undefined && Number(parsed.volume) <= 0.01;
    const prefs: PlayerPrefs = {
      volume: legacyZero ? DEFAULT_PREFS.volume : clampVolume(Number(parsed.volume)),
      muted: parsed.muted === true,
    };
    const height = Number(parsed.height);
    if (Number.isFinite(height) && height > 0) {
      prefs.height = Math.round(height);
    }
    return prefs;
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** 合并写入并返回合并后的结果；写失败不影响播放。 */
export function writePlayerPrefs(patch: Partial<PlayerPrefs>, storage?: Storage): PlayerPrefs {
  const next = { ...readPlayerPrefs(storage), ...patch };
  next.volume = clampVolume(next.volume);
  next.muted = next.muted === true;
  if (next.height !== undefined) {
    next.height = Number.isFinite(next.height) && next.height > 0 ? Math.round(next.height) : undefined;
  }
  const store = storageOf(storage);
  if (!store) {
    return next;
  }
  try {
    store.setItem(KEY, JSON.stringify(next));
  } catch {
    // 配额满 / 被禁用时静默忽略。
  }
  return next;
}
