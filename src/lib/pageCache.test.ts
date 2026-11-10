import { describe, expect, it } from "vitest";
import { CACHE_TTL, createPageCache } from "./pageCache";
import type { CacheStats } from "./pageCache";

describe("load: 缓存命中与 stats", () => {
  it("首次调用 loader 写入缓存，同 key 命中缓存时不再调用 loader 且返回相同值", async () => {
    const cache = createPageCache(() => 0);
    let calls = 0;
    const loader = (): Promise<string> => {
      calls += 1;
      return Promise.resolve("value");
    };

    const first = await cache.load("k", 1000, loader);
    expect(first).toBe("value");
    expect(calls).toBe(1);
    expect(cache.peek<string>("k")).toBe("value");

    const second = await cache.load("k", 1000, loader);
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  it("stats 累计 hits / misses / loads", async () => {
    const cache = createPageCache(() => 0);
    const loader = (): Promise<number> => Promise.resolve(42);

    await cache.load("k", 1000, loader);
    const afterMiss: CacheStats = cache.stats();
    expect(afterMiss.hits).toBe(0);
    expect(afterMiss.misses).toBe(1);
    expect(afterMiss.loads).toBe(1);

    await cache.load("k", 1000, loader);
    const afterHit: CacheStats = cache.stats();
    expect(afterHit.hits).toBe(1);
    expect(afterHit.misses).toBe(1);
    expect(afterHit.loads).toBe(1);
  });
});

describe("load: TTL 与 force", () => {
  it("超过 TTL 后 peek 返回 undefined，再次 load 会重新调用 loader", async () => {
    let now = 0;
    const cache = createPageCache(() => now, 4);
    let calls = 0;
    const loader = (): Promise<string> => {
      calls += 1;
      return Promise.resolve(`v${calls}`);
    };

    await cache.load("k", 100, loader);
    expect(cache.peek<string>("k")).toBe("v1");

    now = 1000; // 推进到超过 ttl=100
    expect(cache.peek<string>("k")).toBeUndefined();

    const again = await cache.load("k", 100, loader);
    expect(again).toBe("v2");
    expect(calls).toBe(2);
    expect(cache.peek<string>("k")).toBe("v2");
  });

  it("force=true 跳过缓存重新调用 loader 并覆盖为新值", async () => {
    const cache = createPageCache(() => 0);
    let calls = 0;
    const loader = (): Promise<string> => {
      calls += 1;
      return Promise.resolve(calls === 1 ? "old" : "new");
    };

    expect(await cache.load("k", 1000, loader)).toBe("old");
    expect(calls).toBe(1);
    expect(cache.peek<string>("k")).toBe("old");

    const forced = await cache.load("k", 1000, loader, true);
    expect(forced).toBe("new");
    expect(calls).toBe(2);
    expect(cache.peek<string>("k")).toBe("new");

    // 覆盖后普通 load 命中新缓存，不再调用 loader
    expect(await cache.load("k", 1000, loader)).toBe("new");
    expect(calls).toBe(2);
  });
});

describe("load: 并发与失败", () => {
  it("并发同 key 共享 in-flight Promise，loader 只调用一次且结果一致", async () => {
    const cache = createPageCache(() => 0);
    let resolveLoad!: (value: string | PromiseLike<string>) => void;
    const pending = new Promise<string>((resolve) => {
      resolveLoad = resolve;
    });
    let calls = 0;
    const loader = (): Promise<string> => {
      calls += 1;
      return pending;
    };

    const a = cache.load("k", 1000, loader);
    const b = cache.load("k", 1000, loader);
    resolveLoad("shared");
    const [ra, rb] = await Promise.all([a, b]);

    expect(calls).toBe(1);
    expect(ra).toBe("shared");
    expect(rb).toBe("shared");
  });

  it("loader reject 不写入缓存、pending 归零，下一次 load 重试成功", async () => {
    const cache = createPageCache(() => 0);
    const failure = new Error("load failed");
    let attempts = 0;
    const loader = (): Promise<string> => {
      attempts += 1;
      return attempts === 1 ? Promise.reject<string>(failure) : Promise.resolve("ok");
    };

    await expect(cache.load("k", 1000, loader)).rejects.toBe(failure);
    expect(cache.peek<string>("k")).toBeUndefined();
    expect(cache.stats().pending).toBe(0);

    expect(await cache.load("k", 1000, loader)).toBe("ok");
    expect(attempts).toBe(2);
    expect(cache.peek<string>("k")).toBe("ok");
    expect(cache.stats().pending).toBe(0);
  });
});

describe("invalidate / clear / setScope", () => {
  it("invalidate 只删除前缀匹配的条目并返回删除数量", async () => {
    const cache = createPageCache(() => 0);
    await cache.load("detail:1", 1000, () => Promise.resolve("d1"));
    await cache.load("detail:2", 1000, () => Promise.resolve("d2"));
    await cache.load("home:1", 1000, () => Promise.resolve("h1"));

    expect(cache.invalidate("detail:")).toBe(2);
    expect(cache.peek<string>("detail:1")).toBeUndefined();
    expect(cache.peek<string>("detail:2")).toBeUndefined();
    expect(cache.peek<string>("home:1")).toBe("h1");
  });

  it("clear 清空所有条目", async () => {
    const cache = createPageCache(() => 0);
    await cache.load("a", 1000, () => Promise.resolve(1));
    await cache.load("b", 1000, () => Promise.resolve(2));
    expect(cache.peek<number>("a")).toBe(1);

    cache.clear();
    expect(cache.peek<number>("a")).toBeUndefined();
    expect(cache.peek<number>("b")).toBeUndefined();
  });

  it("setScope 变化时旧数据不可见，相同 scope 不清空", async () => {
    const cache = createPageCache(() => 0);
    cache.setScope("a");
    expect(await cache.load("k", 1000, () => Promise.resolve("A"))).toBe("A");
    expect(cache.peek<string>("k")).toBe("A");

    cache.setScope("b");
    expect(cache.peek<string>("k")).toBeUndefined();
    expect(await cache.load("k", 1000, () => Promise.resolve("B"))).toBe("B");
    expect(cache.peek<string>("k")).toBe("B");

    cache.setScope("b");
    expect(cache.peek<string>("k")).toBe("B");
  });
});

describe("LRU", () => {
  it("maxEntries=2 时按 LRU 淘汰最久未使用条目", async () => {
    const cache = createPageCache(() => 0, 2);
    await cache.load("a", 1000, () => Promise.resolve("A"));
    await cache.load("b", 1000, () => Promise.resolve("B"));

    // peek(a) 把 a 移到 LRU 末尾，写 c 时最久未使用的 b 应被淘汰
    expect(cache.peek<string>("a")).toBe("A");
    await cache.load("c", 1000, () => Promise.resolve("C"));

    expect(cache.peek<string>("a")).toBe("A");
    expect(cache.peek<string>("b")).toBeUndefined();
    expect(cache.peek<string>("c")).toBe("C");
  });
});

describe("age", () => {
  it("age 随注入时钟增长，不存在的 key 返回 undefined", async () => {
    let now = 0;
    const cache = createPageCache(() => now);
    await cache.load("k", 10_000, () => Promise.resolve("v"));

    now = 30;
    const first = cache.age("k");
    now = 80;
    const second = cache.age("k");

    expect(first).toBe(30);
    expect(second).toBe(80);
    expect(second!).toBeGreaterThan(first!);
    expect(cache.age("missing")).toBeUndefined();
  });
});

describe("CACHE_TTL", () => {
  it("五个字段均为正数且 detail 最大", () => {
    const values = [
      CACHE_TTL.detail,
      CACHE_TTL.home,
      CACHE_TTL.category,
      CACHE_TTL.search,
      CACHE_TTL.live,
    ];
    for (const value of values) {
      expect(value).toBeGreaterThan(0);
    }
    const rest = [
      CACHE_TTL.home,
      CACHE_TTL.category,
      CACHE_TTL.search,
      CACHE_TTL.live,
    ];
    expect(CACHE_TTL.detail).toBeGreaterThan(Math.max(...rest));
  });
});
