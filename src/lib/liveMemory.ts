/**
 * 直播线路偏好记忆。
 *
 * 直播一个频道在源里常有多个线路（m3u 同名条目 / `$` 分隔 / 容器 urls 合并）。
 * 用户手动或自动切换后，记住「这个频道上次用哪条线路」，下次直接复用，也作为
 * 自动顺延的基准。存 localStorage，跨重启保留；键含源标识，避免不同源的同名
 * 频道互相串。配置切换留下的旧条目无害（越界会被钳制到 0）。
 */

import { LIVE_LINES_KEY } from "./storageKeys";

const KEY = LIVE_LINES_KEY;

type LineMap = Record<string, number>;

function load(): LineMap {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as LineMap) : {};
  } catch {
    return {};
  }
}

function save(map: LineMap): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* 隐私模式等写入失败：本次记住即可，不影响播放。 */
  }
}

function memoryKey(sourceKey: string, name: string): string {
  return `${sourceKey}|${name}`;
}

/** 读取某频道上次选择的线路序号，缺省为 0。 */
export function getLiveLine(sourceKey: string, name: string): number {
  const map = load();
  const value = map[memoryKey(sourceKey, name)];
  return typeof value === "number" && value >= 0 ? value : 0;
}

/** 写入某频道上次选择的线路序号（越界值由调用方钳制后传入）。 */
export function setLiveLine(sourceKey: string, name: string, index: number): void {
  const map = load();
  map[memoryKey(sourceKey, name)] = index;
  save(map);
}
