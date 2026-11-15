/**
 * 播放器 HUD 用到的两个格式化：下载速率与已缓冲时长。
 *
 * 单独成模块是因为它们只跟数字有关，能脱离 DOM 单测；格式刻意保持短——
 * 这行字压在画面上，多一个单位前缀都会显得吵。
 */

/** 字节/秒 → `820 B/s` / `52 KB/s` / `3.4 MB/s`；0 或非法值返回空串。 */
export function formatBytesPerSec(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
    return "";
  }
  if (bytesPerSec < 1024) {
    return `${Math.round(bytesPerSec)} B/s`;
  }
  if (bytesPerSec < 1024 * 1024) {
    return `${Math.round(bytesPerSec / 1024)} KB/s`;
  }
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

/** 缓冲秒数 → `8s` / `1:05`；0 或非法值返回空串。 */
export function formatBufferedSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  const whole = Math.floor(seconds);
  if (whole < 60) {
    return `${whole}s`;
  }
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
