//! 收藏源（站点级收藏，不是影片收藏）。
//!
//! 1.1.0 之前「收藏」只存在于影片维度：常用站点每次都要在几十上百个源里
//! 重新找。这里把站点收藏做成纯前端偏好（localStorage），不改后端配置：
//! 用户收藏的是「这台机器上我常看的源」，跟着 active 配置走，换配置时不应
//! 被清掉。
//!
//! 读侧用 `useSyncExternalStore` 订阅：首页站点下拉、换源弹窗、搜索页的
//! 结果排序共用同一份数据，任一处点星，其它地方立刻跟着变。

import { useSyncExternalStore } from "react";
import { FAVORITE_SITES_KEY } from "./storageKeys";

const KEY = FAVORITE_SITES_KEY;

/** 缓存数组：`useSyncExternalStore` 要求快照身份稳定，只有写操作才换新数组。 */
let cached: string[] | null = null;
const listeners = new Set<() => void>();

function normalize(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") {
      continue;
    }
    const key = item.trim();
    if (key) {
      seen.add(key);
    }
  }
  return [...seen];
}

export function readFavoriteSites(): string[] {
  if (cached) {
    return cached;
  }
  try {
    const raw = window.localStorage.getItem(KEY);
    cached = raw ? normalize(JSON.parse(raw)) : [];
  } catch {
    // 隐私模式 / 存储被禁：当作没有收藏，不阻断页面。
    cached = [];
  }
  return cached;
}

function write(next: string[]) {
  cached = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 写不进去也不影响本次会话内的排序。
  }
  listeners.forEach((listener) => listener());
}

export function isFavoriteSite(key: string): boolean {
  return readFavoriteSites().includes(key);
}

/** 切换收藏，返回切换后的状态（true = 现在已收藏）。 */
export function toggleFavoriteSite(key: string): boolean {
  const normalized = key.trim();
  // 空 key 不是合法站点：直接拒绝，别把 `""` 写进 localStorage 变成幽灵收藏。
  if (!normalized) {
    return false;
  }
  const current = readFavoriteSites();
  const has = current.includes(normalized);
  write(
    has
      ? current.filter((item) => item !== normalized)
      : [...current, normalized],
  );
  return !has;
}

/**
 * 仅供测试：丢掉内存快照，下次读取重新解析 localStorage。
 *
 * 运行时不调用 —— 正常路径里快照只该由写操作更新，否则 `useSyncExternalStore`
 * 的引用稳定性会被破坏。
 */
export function __resetSiteFavoritesCache(): void {
  cached = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFavoriteSites(): string[] {
  return useSyncExternalStore(subscribe, readFavoriteSites, () => []);
}

/**
 * 收藏源排前面，其余保持原顺序（`sort` 是稳定排序，同组内不动）。
 *
 * `keyOf` 取站点 key；返回新数组，调用方可以放心传给渲染。
 */
export function favoriteFirst<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const favorite = new Set(readFavoriteSites());
  return [...items].sort((a, b) => {
    const left = favorite.has(keyOf(a)) ? 0 : 1;
    const right = favorite.has(keyOf(b)) ? 0 : 1;
    return left - right;
  });
}
