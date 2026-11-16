/**
 * 覆盖 queryClient 手搓的那部分语义——不是测 TanStack Query 本体，而是测
 * 我们赖以替代 pageCache 的适配层：`force` 绕过新鲜度、并发同 key 去重、TTL
 * 过期回源，以及 `peekFresh` 的 TTL 闸门（useEpisodeList 靠它决定「命中种子就
 * 不发请求」，把过期当命中会漏掉一次必要请求）和 `resetCacheForScope` 的幂等。
 *
 * 用假时钟让「新鲜 / 过期 / 存活时长」判断确定化：react-query 内部的
 * dataUpdatedAt / staleTime 都走 Date.now，被 vi.useFakeTimers 一并接管。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ageCached,
  clearDataCache,
  dropCached,
  loadCached,
  peekFresh,
  putCached,
  resetCacheForScope,
} from "./queryClient";

const TTL = 1000;

describe("loadCached：命中新鲜缓存 / force / 并发去重", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 10_000 });
    clearDataCache();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("TTL 内第二次读命中缓存，不再调用 loader", async () => {
    const loader = vi.fn(async () => "v");
    expect(await loadCached("k", TTL, loader)).toBe("v");
    vi.advanceTimersByTime(TTL - 1);
    expect(await loadCached("k", TTL, loader)).toBe("v");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("超过 TTL 后回源", async () => {
    const loader = vi.fn(async () => "v");
    await loadCached("k", TTL, loader);
    vi.advanceTimersByTime(TTL + 1);
    await loadCached("k", TTL, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("force=true 绕过新鲜度强制回源", async () => {
    const loader = vi.fn(async () => "v");
    await loadCached("k", TTL, loader);
    await loadCached("k", TTL, loader, true);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("同 key 并发只发一次 loader（StrictMode 双挂载 / 详情+播放页同读）", async () => {
    const loader = vi.fn(
      () => new Promise<string>((res) => setTimeout(() => res("v"), 50)),
    );
    const p1 = loadCached("k", TTL, loader);
    const p2 = loadCached("k", TTL, loader);
    await vi.advanceTimersByTimeAsync(50);
    expect(await p1).toBe("v");
    expect(await p2).toBe("v");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("loader 抛错不写缓存：下次仍会重试", async () => {
    let n = 0;
    const loader = vi.fn(async () => {
      n += 1;
      if (n === 1) {
        throw new Error("boom");
      }
      return "ok";
    });
    await expect(loadCached("k", TTL, loader)).rejects.toThrow("boom");
    expect(await loadCached("k", TTL, loader)).toBe("ok");
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("peekFresh：只认未过期条目", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 10_000 });
    clearDataCache();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("未写过返回 undefined", () => {
    expect(peekFresh("missing", TTL)).toBeUndefined();
  });

  it("TTL 内命中、过期后返回 undefined（不返回旧值）", async () => {
    await loadCached("k", TTL, async () => [1, 2, 3]);
    expect(peekFresh<number[]>("k", TTL)).toEqual([1, 2, 3]);
    vi.advanceTimersByTime(TTL + 1);
    expect(peekFresh<number[]>("k", TTL)).toBeUndefined();
  });

  it("putCached 写入后立即可 peek，ageCached 反映存活时长", () => {
    putCached("k", ["x"]);
    expect(peekFresh<string[]>("k", TTL)).toEqual(["x"]);
    expect(ageCached("k")).toBe(0);
    vi.advanceTimersByTime(2500);
    expect(ageCached("k")).toBe(2500);
    expect(ageCached("absent")).toBeUndefined();
  });

  it("dropCached 丢弃后再读会回源", async () => {
    const loader = vi.fn(async () => "v");
    await loadCached("k", TTL, loader);
    dropCached("k");
    expect(peekFresh("k", TTL)).toBeUndefined();
    await loadCached("k", TTL, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("resetCacheForScope：仅在 scope 变化时整体作废", () => {
  // 只有这个用例碰 currentScope，且走完整序列，故与其它用例无顺序耦合。
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("同 id 幂等不清、换 id 清空", async () => {
    // 初始 currentScope="default"。
    resetCacheForScope("cfg1"); // default→cfg1：清空（本就空）。
    await loadCached("d", 60_000, async () => "a");
    resetCacheForScope("cfg1"); // 同 id：不清，命中。
    expect(peekFresh("d", 60_000)).toBe("a");
    resetCacheForScope("cfg2"); // 换 id：整体清空。
    expect(peekFresh("d", 60_000)).toBeUndefined();
    // 复位，避免污染其它 describe（虽然只有本用例改 scope）。
    resetCacheForScope("default");
  });
});
