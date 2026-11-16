import { describe, expect, it } from "vitest";
import { CACHE_TTL } from "../lib/queryClient";
import { findHomeSiteWithList, shouldSkipHomeRequest } from "./HomePage";

const sites = ["douban", "live", "short", "apple", "maple"].map((key) => ({ key }));

describe("findHomeSiteWithList", () => {
  it("picks the first later site that actually returns a list", async () => {
    const called: string[] = [];
    const next = await findHomeSiteWithList(sites, "douban", async (key) => {
      called.push(key);
      // 豆瓣空、直播空、短剧有 3 条 → 应停在 short，不再往后试探。
      const list = key === "short" ? [1, 2, 3] : [];
      return { list };
    });
    expect(next).toBe("short");
    expect(called).toEqual(["live", "short"]);
  });

  it("returns null when every later site is empty", async () => {
    const next = await findHomeSiteWithList(sites, "douban", async () => ({ list: [] }));
    expect(next).toBeNull();
  });

  it("skips sites whose probe throws and keeps going", async () => {
    const next = await findHomeSiteWithList(sites, "douban", async (key) => {
      if (key === "live") throw new Error("timeout");
      return { list: key === "apple" ? [1] : [] };
    });
    expect(next).toBe("apple");
  });

  it("only probes up to the limit, never the whole config", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ key: `s${i}` }));
    const called: string[] = [];
    const next = await findHomeSiteWithList(many, "s0", async (key) => {
      called.push(key);
      return { list: [] };
    });
    expect(next).toBeNull();
    expect(called.length).toBeLessThanOrEqual(6);
  });

  it("returns null and stops probing once no longer alive", async () => {
    let calls = 0;
    const next = await findHomeSiteWithList(
      sites,
      "douban",
      async () => {
        calls += 1;
        return { list: [] };
      },
      () => false,
    );
    expect(next).toBeNull();
    expect(calls).toBe(0);
  });

  it("returns null for an unknown current site", async () => {
    const next = await findHomeSiteWithList(sites, "missing", async () => ({ list: [1] }));
    expect(next).toBeNull();
  });
});

describe("shouldSkipHomeRequest", () => {
  const fresh = {
    owned: true,
    hasList: true,
    storedAt: 1000,
    reload: 0,
    force: false,
  };
  const now = 1000 + CACHE_TTL.home - 1; // 页内缓存在 TTL 内（差 1ms）

  it("skips the request when a fresh, owned, non-empty cache is on screen", () => {
    expect(shouldSkipHomeRequest(fresh, now)).toBe(true);
  });

  it("goes through the request path once the in-page cache exceeds the TTL", () => {
    // 挂了几小时再回首页：storedAt 落后超过 CACHE_TTL.home → 不再跳过，
    // 让 数据缓存 层得到一次回源机会（这正是 TTL 归位要修的点）。
    const aged = { ...fresh, storedAt: 1000 };
    expect(shouldSkipHomeRequest(aged, 1000 + CACHE_TTL.home)).toBe(false);
  });

  it("never skips an empty result so the home can self-heal", () => {
    expect(shouldSkipHomeRequest({ ...fresh, hasList: false }, now)).toBe(false);
  });

  it("never skips data owned by a different site", () => {
    expect(shouldSkipHomeRequest({ ...fresh, owned: false }, now)).toBe(false);
  });

  it("skips neither manual refresh nor an active site switch", () => {
    expect(shouldSkipHomeRequest({ ...fresh, reload: 1 }, now)).toBe(false);
    expect(shouldSkipHomeRequest({ ...fresh, force: true }, now)).toBe(false);
  });

  it("treats the TTL boundary as half-open: exactly ttl is already stale", () => {
    expect(shouldSkipHomeRequest(fresh, 1000 + CACHE_TTL.home - 1)).toBe(true);
    expect(shouldSkipHomeRequest(fresh, 1000 + CACHE_TTL.home)).toBe(false);
  });
});
