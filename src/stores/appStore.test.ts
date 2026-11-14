import { describe, expect, it } from "vitest";
import { EMPTY_LIVES, selectLives, useAppStore } from "./appStore";
import type { SiteCache } from "./appStore";

/**
 * 回归：没导入配置时进直播页会 `Maximum update depth exceeded` 白屏。
 *
 * 根因是 `LivePageRoute` 的选择器写成 `s.cache?.lives ?? []`：cache 为 null 时
 * 每次给 zustand 一个新数组，Object.is 判定「快照变了」→ 无限重渲染。
 * 这里锁住「空态下引用恒定」这个不变量，页面侧才有稳定快照。
 */
describe("selectLives", () => {
  const base = useAppStore.getState();

  it("returns one stable array when no config has been imported", () => {
    const state = { ...base, cache: null };
    expect(selectLives(state)).toBe(EMPTY_LIVES);
    // 关键：连续两次取到的必须是同一个引用（新数组会让 useSyncExternalStore 死循环）。
    expect(selectLives(state)).toBe(selectLives(state));
  });

  it("returns the very same array the cache holds", () => {
    const lives = [{ name: "cluntop", url: "https://example.com/a.m3u" }];
    const cache: SiteCache = { configId: "c1", sites: [], lives };
    expect(selectLives({ ...base, cache })).toBe(lives);
  });

  it("keeps the empty reference when the cache has an empty lives list", () => {
    const cache: SiteCache = { configId: "c1", sites: [], lives: [] };
    const state = { ...base, cache };
    expect(selectLives(state)).toBe(selectLives(state));
  });
});
