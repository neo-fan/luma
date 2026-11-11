import { describe, expect, it } from "vitest";
import { findHomeSiteWithList } from "./HomePage";

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
