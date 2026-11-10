/**
 * 页面 UI 状态快照。
 *
 * App 的视图栈在切换时会卸载组件，仅缓存网络数据仍会丢掉「选到第几条线路、
 * 剧集筛选词、倒序、搜索关键词与结果、当前页码」这些状态。这个 hook 把状态
 * 存在模块级 LRU Map 里：组件重新挂载时读回上次的值，卸载不丢。
 *
 * 与 pageCache 的区别：这里存的是 UI 状态（可含渲染结果），没有 TTL；
 * 配置切换时由 App 调 clearPageStates() 整体清空。播放页不使用——它持有
 * ArtPlayer / hls.js 实例，缓存状态反而不利于释放解码资源。
 */
import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

const MAX_STATES = 80;
const states = new Map<string, unknown>();

/** 读取并刷新 LRU 顺序。 */
function read<T>(key: string, initial: T): T {
  if (!states.has(key)) {
    return initial;
  }
  const saved = states.get(key);
  states.delete(key);
  states.set(key, saved);
  return saved as T;
}

function write<T>(key: string, value: T): void {
  states.delete(key);
  states.set(key, value);
  while (states.size > MAX_STATES) {
    const oldest = states.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    states.delete(oldest);
  }
}

/** 用法与 useState 完全一致，只是值会跨「卸载→重新挂载」保留。 */
export function usePageState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => read(key, initial));
  useEffect(() => {
    write(key, value);
  }, [key, value]);
  return [value, setValue];
}

/** 切换 active 配置后旧页面的筛选/列表状态不再适用。 */
export function clearPageStates(): void {
  states.clear();
}

export function pageStateSize(): number {
  return states.size;
}
