/**
 * 页面 UI 状态快照。
 *
 * App 的视图栈在切换时会卸载组件，仅缓存网络数据仍会丢掉「选到第几条线路、
 * 剧集筛选词、倒序、搜索关键词与结果、当前页码」这些状态。这个 hook 把状态
 * 存在模块级 LRU Map 里：组件重新挂载时读回上次的值，卸载不丢。
 *
 * 与 数据缓存 的区别：这里存的是 UI 状态（可含渲染结果），没有 TTL；
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

/**
 * 用法与 useState 完全一致，只是值会跨「卸载→重新挂载」保留。
 * key 变化时把状态切到新 key 对应的存储值（或 initial），避免沿用旧 key 的
 * 残留值——这正是动态 key（如 `home:${siteKey}:data`、`live:${sourceKey}:groups`）
 * 能按 key 各自缓存的前提。旧 key 的值仍留在 LRU 里，切回去会读回。
 *
 * 重置发生在**渲染期**（React 官方的 deriving-state-from-props 模式）而不是
 * effect：effect 版要晚一个 commit，中间那一帧调用方拿到的还是旧 key 的值，
 * 依赖「值归属」的判断（首页换源的骨架/跳过请求）会全部失真。
 */
export function usePageState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => read(key, initial));
  const [lastKey, setLastKey] = useState(key);
  // key 变了：本次渲染直接读新 key 的存储值，并安排一次写回对齐。
  // 注意 setState 后不提前 return——条件跳过 useEffect 会违反 Hook 调用
  // 顺序规则（Should have a queue 崩溃，2026-11-15 实测）。
  let derived = value;
  if (lastKey !== key) {
    derived = read(key, initial);
    setLastKey(key);
    setValue(derived);
  }
  const syncedKey = lastKey !== key ? key : undefined;
  useEffect(() => {
    if (syncedKey !== undefined) {
      // 刚换过 key 的这一次提交不做写回：value 此刻还是旧 key 的值，
      // 写回去会污染新 key 的存储；setState 触发的下一次渲染正常写回。
      return;
    }
    write(key, value);
  }, [key, value, syncedKey]);
  return [derived, setValue];
}

/** 切换 active 配置后旧页面的筛选/列表状态不再适用。 */
export function clearPageStates(): void {
  states.clear();
}

