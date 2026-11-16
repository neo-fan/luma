/**
 * 页面级内存数据缓存——TanStack Query 承载。
 *
 * 2.0.0 前这里是手搓的 `pageCache`（TTL + LRU + in-flight 去重 + 配置 scope）。
 * 这些能力 TanStack Query 原生就有，且久经考验：
 *   1. in-flight 去重：同 queryKey 的并发 `fetchQuery` 共享一次请求（StrictMode
 *      双挂载、详情页与播放页同时读同一份详情，N 次 IPC 收敛成 1 次）——内置；
 *   2. TTL 新鲜度：`staleTime` 即「多久内算新鲜、不重复回源」；
 *   3. 容量回收：`gcTime` 在条目无人使用一段时间后释放（替代原先按条数 60 的 LRU）；
 *   4. 配置 scope：切配置时 `resetCacheForScope` / `clearDataCache` 整体作废。
 *
 * 刻意保持**命令式门面**：调用方仍像用 pageCache 一样 `loadCached(key, ttl, fn, force)`，
 * 而不是把 `api.*` 换成 `useQuery` hook。原因见 `invoke.ts`——`home`/`category`/
 * `detail` 各自背着「空结果不缓存 / 自愈回查写回 / 命中也要 rememberCards」这些历史
 * bug 修复逻辑，是事件与 effect 驱动的读取，声明式 hook 反而更难忠实表达。
 * QueryClient 单例在这里直接 `fetchQuery`，无需 React Provider（无 observer）。
 */
import { QueryClient } from "@tanstack/react-query";

/**
 * 缓存时长（毫秒）。影片详情变动最少、代价最高，给最长 TTL。
 * 原样从 pageCache 搬来，HomePage 的「页内缓存超过 TTL 不再跳过请求」闸门也读它。
 */
export const CACHE_TTL = {
  detail: 10 * 60_000,
  home: 5 * 60_000,
  category: 5 * 60_000,
  search: 2 * 60_000,
  live: 5 * 60_000,
} as const;

/**
 * 无人使用后保留条目的上限。原 pageCache 是「上限 60 条的 LRU」，这里换成时间维度的
 * GC：条目在最后一次被使用后、活过 `gcTime` 才回收。桌面浏览会话里条目都是小 JSON，
 * 30 分钟足以覆盖「看几部片再切回来」的秒开需求，又能随浏览推进自然有界。
 */
const GC_TIME = 30 * 60_000;

/**
 * 全局单例。所有默认行为都关掉自动网络活动：读取一律由 `loadCached`（内部
 * `fetchQuery`）显式发起，没有观察器去 focus/reconnect 时自动重拉——这正是原
 * pageCache 的语义（只有被 `load` 时才会回源）。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 重试策略由调用方自己控制（如 category 的空结果重试一次），这里不叠加。
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      // 无观察器，纯 fetchQuery 驱动；不让挂载/重挂触发隐式回源。
      refetchOnMount: false,
      staleTime: 0,
      gcTime: GC_TIME,
    },
  },
});

/**
 * 命中新鲜缓存即返回，否则调用 loader（同 key 并发共享一个请求）。
 * `force` 为真时绕过新鲜度强制回源——语义与原 `pageCache.load` 完全一致。
 * loader 抛错不写缓存（react-query 只缓存 fulfilled 结果），下次 load 可重试。
 */
export function loadCached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  force = false,
): Promise<T> {
  return queryClient.fetchQuery<T>({
    queryKey: [key],
    queryFn: loader,
    // force：staleTime=0，永远判旧 → 必回源；否则 ttlMs 内视为新鲜直接返回缓存。
    staleTime: force ? 0 : ttlMs,
    gcTime: GC_TIME,
  });
}

/**
 * 同步读未过期的值，只用于首屏直出 / 首帧种子；超过 TTL 返回 undefined。
 *
 * 必须自带 TTL 判断（不能直接 `getQueryData`）：`useEpisodeList` 靠「没命中种子才发
 * 请求」决定要不要回源——若把已过期数据当命中返回，会错误地跳过一次必要请求。
 */
export function peekFresh<T>(key: string, ttlMs: number): T | undefined {
  const state = queryClient.getQueryState([key]);
  if (!state || state.dataUpdatedAt === 0) {
    return undefined;
  }
  if (Date.now() - state.dataUpdatedAt > ttlMs) {
    return undefined;
  }
  return queryClient.getQueryData([key]) as T | undefined;
}

/** 直接写入一个已取得的结果（例如按片名回查恢复的详情），并视为刚刚更新。 */
export function putCached(key: string, value: unknown): void {
  queryClient.setQueryData([key], value);
}

/** 丢弃某个 key 的条目（含在途请求）——空结果不缓存、重试前清旧值都走这里。 */
export function dropCached(key: string): void {
  queryClient.removeQueries({ queryKey: [key] });
}

/** 条目已存活的毫秒数，不存在返回 undefined（DetailPage 的「N 分钟前缓存」标注）。 */
export function ageCached(key: string): number | undefined {
  const state = queryClient.getQueryState([key]);
  if (!state || state.dataUpdatedAt === 0) {
    return undefined;
  }
  return Date.now() - state.dataUpdatedAt;
}

/** 整体清空（导入/删除配置等一次性清场）。 */
export function clearDataCache(): void {
  queryClient.clear();
}

/**
 * 当前缓存归属的配置 id。仅用于让 `resetCacheForScope` 在 id 未变时保持幂等——
 * 对齐旧 `pageCache.setScope`：启动时周期性用 active 配置「对齐」scope，同 id
 * 不应把已攒热的缓存整体洗掉。
 */
let currentScope = "default";

/** scope 变化则整体清空；相同 scope 不动。 */
export function resetCacheForScope(scope: string): void {
  const next = scope || "default";
  if (next === currentScope) {
    return;
  }
  currentScope = next;
  queryClient.clear();
}
