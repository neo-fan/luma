/**
 * 播放偏好（音量 / 倍速 / 上次清晰度）。
 *
 * 连看 36 集时，每集都把音量、倍速重置回默认是最烦的体验问题之一；这里把
 * 三个值落到 localStorage，新一集 / 下一部片都沿用。清晰度只在「同一档位
 * 仍存在」时套用，源站换码率就退回自动，避免硬套一个不存在的档位。
 */

export interface PlayerPrefs {
  /** 0~1。 */
  volume: number;
  /** 倍速，0.5~3，实际可选值见 ArtPlayer 菜单。 */
  rate: number;
  /** 上次选中的清晰度高度（如 1080）；缺省表示跟随自动。 */
  height?: number;
}

export const DEFAULT_PREFS: PlayerPrefs = { volume: 0.8, rate: 1 };

const KEY = "luma:player:prefs";

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

export function clampRate(value: number): number {
  return clamp(value, 0.5, 3, DEFAULT_PREFS.rate);
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
    const prefs: PlayerPrefs = {
      volume: clampVolume(Number(parsed.volume)),
      rate: clampRate(Number(parsed.rate)),
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
  next.rate = clampRate(next.rate);
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
