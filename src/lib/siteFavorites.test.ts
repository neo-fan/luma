/**
 * 收藏源：纯前端偏好，读侧走 `useSyncExternalStore` 共享一份缓存。
 *
 * 这里锁四件事：localStorage 容错（隐私模式 / 手改坏 JSON）、空 key 不落库、
 * 切换幂等，以及排序是「稳定」的——收藏只把站点提到前面，同组内按列表原本的
 * 顺序排列（不按点击先后）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
};

vi.stubGlobal("window", { localStorage: localStorageStub });

const {
  __resetSiteFavoritesCache,
  favoriteFirst,
  isFavoriteSite,
  readFavoriteSites,
  toggleFavoriteSite,
} = await import("./siteFavorites");

beforeEach(() => {
  store.clear();
  // 快照是模块级的：清掉它，下一次读取才会重新解析 storage。
  __resetSiteFavoritesCache();
});

describe("siteFavorites", () => {
  it("切换收藏，返回切换后的状态", () => {
    expect(toggleFavoriteSite("a")).toBe(true);
    expect(isFavoriteSite("a")).toBe(true);
    expect(toggleFavoriteSite("a")).toBe(false);
    expect(isFavoriteSite("a")).toBe(false);
  });

  it("空 key 不落库，坏 JSON / 非字符串项按空处理", () => {
    expect(toggleFavoriteSite("   ")).toBe(false);
    expect(readFavoriteSites()).toEqual([]);

    store.set("luma:favorite-sites", "{not json");
    __resetSiteFavoritesCache();
    expect(readFavoriteSites()).toEqual([]);

    store.set("luma:favorite-sites", JSON.stringify(["a", 1, "  ", "a", " b "]));
    __resetSiteFavoritesCache();
    // 去重 + trim + 丢掉非字符串；顺序按写入先后。
    expect(readFavoriteSites()).toEqual(["a", "b"]);
  });

  it("收藏源稳定地排到前面，其余保持原顺序", () => {
    toggleFavoriteSite("c");
    toggleFavoriteSite("a");
    const items = ["a", "b", "c", "d"];
    // 收藏组内部仍按 items 原本的顺序（a 在 c 前），不按点击先后。
    expect(favoriteFirst(items, (key) => key)).toEqual(["a", "c", "b", "d"]);
    expect(items).toEqual(["a", "b", "c", "d"]);
  });
});
