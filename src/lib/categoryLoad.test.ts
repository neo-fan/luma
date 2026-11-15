import { describe, expect, it, vi } from "vitest";
import { loadCategoryPage } from "./categoryLoad";
import type { ResultPage } from "../types/luma";

const pageWith = (count: number): ResultPage => ({
  list: Array.from({ length: count }, (_, i) => ({ vod_id: String(i), vod_name: `片 ${i}` })) as ResultPage["list"],
  filters: {},
  pagecount: 3,
  page: 1,
  limit: 20,
  total: count,
});

describe("loadCategoryPage", () => {
  it("returns a non-empty page without retrying or invalidating", async () => {
    const load = vi.fn(async () => pageWith(20));
    const invalidate = vi.fn();
    const result = await loadCategoryPage(load, invalidate);
    expect(result.list).toHaveLength(20);
    expect(load).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("drops a transient empty result from cache and retries once", async () => {
    const load = vi.fn().mockResolvedValueOnce(pageWith(0)).mockResolvedValueOnce(pageWith(20));
    const invalidate = vi.fn();
    const onRetry = vi.fn();
    const result = await loadCategoryPage(load, invalidate, false, onRetry);
    expect(result.list).toHaveLength(20);
    expect(load.mock.calls).toEqual([[false], [true]]);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith("empty", 1);
  });

  it("never caches a truly empty page", async () => {
    const load = vi.fn(async () => pageWith(0));
    const invalidate = vi.fn();
    const onRetry = vi.fn();
    const result = await loadCategoryPage(load, invalidate, false, onRetry);
    expect(result.list).toHaveLength(0);
    expect(load).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls).toEqual([["empty", 1], ["empty", 2]]);
  });

  it("retries a thrown IPC error once before surfacing it", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(pageWith(20));
    const invalidate = vi.fn();
    const onRetry = vi.fn();
    const result = await loadCategoryPage(load, invalidate, false, onRetry);
    expect(result.list).toHaveLength(20);
    expect(load.mock.calls).toEqual([[false], [true]]);
    expect(invalidate).not.toHaveBeenCalled();
    expect(onRetry).toHaveBeenCalledWith("error", 1);
  });

  it("honors the caller's force flag on the first attempt", async () => {
    const load = vi.fn(async () => pageWith(20));
    await loadCategoryPage(load, vi.fn(), true);
    expect(load.mock.calls).toEqual([[true]]);
  });
});
