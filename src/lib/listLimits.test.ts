import { describe, expect, it } from "vitest";
import { capItems, clampLoadedPages, dropLru, putLru } from "./listLimits";

describe("listLimits: display caps", () => {
  it("copies short lists without claiming truncation", () => {
    const source = [1, 2, 3];
    const result = capItems(source, 5);
    expect(result).toEqual({ items: [1, 2, 3], truncated: false, total: 3 });
    expect(result.items).not.toBe(source);
  });

  it("keeps the first N items and reports the original total", () => {
    const result = capItems(["a", "b", "c", "d"], 2);
    expect(result).toEqual({ items: ["a", "b"], truncated: true, total: 4 });
  });

  it("treats zero and negative limits as keep nothing", () => {
    expect(capItems([1], 0)).toEqual({ items: [], truncated: true, total: 1 });
    expect(capItems([], -1)).toEqual({ items: [], truncated: false, total: 0 });
  });

  it("clamps loaded pages into a valid range", () => {
    expect(clampLoadedPages(7, 20)).toBe(7);
    expect(clampLoadedPages(30, 20)).toBe(20);
    expect(clampLoadedPages(-2, 20)).toBe(1);
    expect(clampLoadedPages(Number.NaN, 20)).toBe(1);
    expect(clampLoadedPages(5, 0)).toBe(1);
  });
});

describe("listLimits: snapshot LRU", () => {
  it("keeps the most recently used snapshots within the cap", () => {
    let store = putLru<number>({ values: {}, order: [] }, "a", 1, 3);
    store = putLru(store, "b", 2, 3);
    store = putLru(store, "c", 3, 3);
    store = putLru(store, "a", 11, 3);

    expect(store.order).toEqual(["a", "c", "b"]);
    expect(store.values).toEqual({ a: 11, c: 3, b: 2 });

    store = putLru(store, "d", 4, 3);
    expect(store.order).toEqual(["d", "a", "c"]);
    expect(store.values).toEqual({ d: 4, a: 11, c: 3 });
  });

  it("drops a snapshot by key and is a no-op for unknown keys", () => {
    const store = putLru({ values: {}, order: [] }, "a", 1, 2);
    const dropped = dropLru(store, "a");
    expect(dropped).toEqual({ values: {}, order: [] });
    expect(dropLru(dropped, "missing")).toBe(dropped);
  });
});
