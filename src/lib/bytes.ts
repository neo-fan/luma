/**
 * 播放器控制栏读数的格式化：下载速率。
 *
 * 单独成模块是因为它只跟数字有关，能脱离 DOM 单测；格式刻意保持短——
 * 它挤在控制栏里，多一个单位前缀都会显得吵。缓冲进度交给进度条本身，
 * 不再单独显示「已缓冲 Ns」。
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
