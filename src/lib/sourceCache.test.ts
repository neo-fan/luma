import { describe, expect, it, vi } from "vitest";
import { createSourceCache } from "./sourceCache";
import { SOURCE_CACHE_TTL } from "./sourceCache";
import type { SourceCacheOptions } from "./sourceCache";
import type { AggregateRow } from "./sources";
import { EMPTY_SOURCE_STATS } from "./sources";
import type { ResultPage, Site, VodInfo } from "../types/luma";

const TITLE = "庆余年 第二季";

function vod(vodName: string, vodId: string): VodInfo {
  return {
    vod_id: vodId,
    vod_name: vodName,
    vod_pic: "",
    vod_play_from: "",
    vod_play_url: "",
  };
}

function page(list: VodInfo[]): ResultPage {
  return {
    list,
    filters: {},
    pagecount: 1,
    page: 1,
    limit: list.length,
    total: list.length,
  };
}

function row(siteKey: string, list: VodInfo[], ok = true): AggregateRow {
  return { siteKey, ok, data: page(list) };
}

function site(key: string, name = key): Site {
  return {
    key,
    name,
    runtime: "cms",
    api: "",
    headers: {},
    searchable: true,
    quickSearch: false,
    filterable: false,
    categories: [],
    timeoutMs: 15000,
    enabled: true,
  };
}

/** 真实配置里「一次搜索在每个站点各返回一条同名影片」。 */
const SITES = [site("s1", "源甲"), site("s2", "源乙"), site("s3", "源丙")];
const ROWS: AggregateRow[] = [
  row("s1", [vod(TITLE, "a1")]),
  row("s2", [vod("庆余年第二季 4K", "b1")]),
  row("s3", [vod("庆余年 第一季", "c1")]),
];

function setup(overrides: Partial<SourceCacheOptions> = {}) {
  const fetchRows = vi.fn(
    async (_keyword: string, _sites: readonly Site[], _timeoutMs: number) => ({
      rows: ROWS,
      stats: { ...EMPTY_SOURCE_STATS, total: 3, ok: 3, tookMs: 1200 },
    }),
  );
  const fetchDetail = vi.fn(async () => []);
  const cache = createSourceCache({ fetchRows, fetchDetail, ...overrides });
  const publishSearch = (word = TITLE) =>
    cache.publish(word, ROWS, SITES, { ...EMPTY_SOURCE_STATS, total: 3, ok: 3 }, "search");
  return { cache, fetchRows, fetchDetail, publishSearch };
}

describe("sourceCache 搜索结果复用", () => {
  it("搜索结果发布后按片名同步派生候选，不发起任何检索 IPC", () => {
    const { cache, fetchRows, publishSearch } = setup();
    publishSearch();
    const view = cache.view(TITLE, SITES, "s1");

    expect(view.cached).toBe(true);
    expect(view.complete).toBe(true);
    expect(view.pending).toBe(false);
    expect(view.origin).toBe("search");
    // s3「庆余年 第一季」是 1 分弱匹配，保留给关掉筛选的用户手动查看。
    expect(view.options.map((item) => item.siteKey)).toEqual(["s2", "s3"]);
    expect(view.options[0]).toMatchObject({ vodId: "b1", matchScore: 2 });
    expect(view.stats.total).toBe(3);
    expect(fetchRows).not.toHaveBeenCalled();
    expect(cache.stats().publishes).toBe(1);
  });

  it("归一化片名（去空格/标点）命中同一份缓存", () => {
    const { cache, fetchRows, publishSearch } = setup();
    publishSearch("庆余年第二季");
    const view = cache.view("庆余年·第二季", SITES);
    expect(view.cached).toBe(true);
    expect(fetchRows).not.toHaveBeenCalled();
  });

  it("搜索词就是完整片名时，详情/播放页后台预取不再重复检索", () => {
    const { cache, fetchRows, publishSearch } = setup();
    publishSearch();
    cache.prefetch(TITLE, SITES);
    cache.prefetch(TITLE, SITES);
    expect(fetchRows).not.toHaveBeenCalled();
    expect(cache.stats().aggregateCalls).toBe(0);
  });

  it("无关关键词的缓存不会混进当前片名的候选", () => {
    const { cache, publishSearch } = setup();
    publishSearch("甄嬛传");
    // 缓存行里全是「庆余年」，用「甄嬛传」派生时相关度为 0。
    const view = cache.view("甄嬛传", SITES);
    expect(view.options).toEqual([]);
    expect(view.cached).toBe(false);
  });

  it("排除当前源、按相关度降序，弱匹配也保留供用户手动查看", () => {
    const { cache, publishSearch } = setup();
    publishSearch();
    const view = cache.view(TITLE, SITES);
    expect(view.options.map((item) => [item.siteKey, item.matchScore])).toEqual([
      ["s1", 3],
      ["s2", 2],
      ["s3", 1],
    ]);
  });
});

describe("sourceCache 后台补全", () => {
  it("搜索词只是片名片段时，后台补一次完整片名检索并合并候选", async () => {
    const { cache, fetchRows, publishSearch } = setup();
    publishSearch("庆余年");

    const before = cache.view(TITLE, SITES);
    expect(before.complete).toBe(false);

    cache.prefetch(TITLE, SITES);
    await vi.waitFor(() => expect(fetchRows).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(cache.view(TITLE, SITES).complete).toBe(true));

    expect(fetchRows.mock.calls[0][0]).toBe(TITLE);
    expect(cache.view(TITLE, SITES).options.length).toBeGreaterThanOrEqual(2);
    expect(cache.stats().prefetches).toBe(1);
  });

  it("同一个片名并发/重复 ensure 共享 in-flight，只发一次聚合", async () => {
    const { cache, fetchRows, publishSearch } = setup();
    publishSearch("庆余年");

    const [a, b] = await Promise.all([
      cache.ensure(TITLE, SITES),
      cache.ensure(TITLE, SITES),
    ]);
    expect(fetchRows).toHaveBeenCalledTimes(1);
    expect(a.complete && b.complete).toBe(true);
    await cache.ensure(TITLE, SITES);
    expect(fetchRows).toHaveBeenCalledTimes(1);
  });

  it("手动重新搜索强制刷新，并允许下次再强制刷新", async () => {
    const { cache, fetchRows, publishSearch } = setup();
    publishSearch();
    await cache.refresh(TITLE, SITES, "s1", 35_000);
    expect(fetchRows).toHaveBeenCalledTimes(1);
    expect(fetchRows.mock.calls[0][2]).toBe(35_000);
    await cache.refresh(TITLE, SITES, "s1");
    expect(fetchRows).toHaveBeenCalledTimes(2);
  });

  it("短预算（partial）检索拿到结果但不标完整，之后仍会补全", async () => {
    const { cache, fetchRows } = setup();
    const view = await cache.ensure(TITLE, SITES, "", { timeoutMs: 8_000, partial: true });
    expect(fetchRows.mock.calls[0][2]).toBe(8_000);
    expect(view.options.length).toBeGreaterThan(0); // 结果可用
    expect(view.complete).toBe(false); // 慢站可能没回来，不能算完整

    // 下一次正常 ensure 必须再发一次，把慢站补上。
    await cache.ensure(TITLE, SITES);
    expect(fetchRows).toHaveBeenCalledTimes(2);
    expect(cache.view(TITLE, SITES).complete).toBe(true);
  });

  it("检索结果过期后不再假装完整，会重新检索一次", async () => {
    let clock = 1_000;
    const { cache, fetchRows } = setup({ now: () => clock });
    await cache.ensure(TITLE, SITES);
    expect(fetchRows).toHaveBeenCalledTimes(1);

    // bundle 与「已完整检索」必须同步过期：否则这次会直接返回空视图，
    // 跨源自愈拿到 0 个候选（日志里 probed:0 的成因）。
    clock += SOURCE_CACHE_TTL + 1;
    const view = await cache.ensure(TITLE, SITES);
    expect(fetchRows).toHaveBeenCalledTimes(2);
    expect(view.options.length).toBeGreaterThan(0);
    expect(view.complete).toBe(true);
  });

  it("后台预取失败时保留已有搜索缓存，手动刷新则把错误抛给面板", async () => {
    const fetchRows = vi.fn(async () => {
      throw new Error("offline");
    });
    const cache = createSourceCache({ fetchRows, fetchDetail: vi.fn() });
    cache.publish("庆余年", ROWS, SITES, { ...EMPTY_SOURCE_STATS, total: 3 }, "search");

    const view = await cache.ensure(TITLE, SITES);
    expect(view.cached).toBe(true); // 搜索缓存仍可展示
    expect(view.complete).toBe(false); // 没标 complete，下次可重试
    await expect(cache.refresh(TITLE, SITES, "")).rejects.toThrow("offline");
  });
});

describe("sourceCache 生命周期", () => {
  it("publish 会通知订阅者，取消订阅后不再通知", () => {
    const { cache, publishSearch } = setup();
    const listener = vi.fn();
    const off = cache.subscribe(listener);
    publishSearch();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    publishSearch();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("配置切换 / clear 后旧候选与完整标记一并失效", () => {
    const { cache, publishSearch } = setup();
    publishSearch();
    expect(cache.view(TITLE, SITES).cached).toBe(true);
    cache.setScope("new-config");
    expect(cache.view(TITLE, SITES).cached).toBe(false);
    expect(cache.stats().bundles).toBe(0);
  });

  it("TTL 过期后不再命中缓存", () => {
    let now = 1000;
    const { cache, publishSearch } = setup({ now: () => now, ttlMs: 5000 });
    publishSearch();
    expect(cache.view(TITLE, SITES).cached).toBe(true);
    now = 7000;
    expect(cache.view(TITLE, SITES).cached).toBe(false);
  });

  it("预热只跑前 4 个片名匹配候选，且同一候选不重复", async () => {
    const { cache, fetchDetail } = setup();
    const base = {
      siteKey: "x",
      siteName: "源",
      vodId: "v",
      vodName: TITLE,
      matchScore: 3,
    };
    const many = Array.from({ length: 6 }, (_, index) => ({
      ...base,
      siteKey: `x${index}`,
      vodId: `v${index}`,
    }));
    await cache.warmDetails(many);
    expect(fetchDetail).toHaveBeenCalledTimes(4);
    await cache.warmDetails(many);
    expect(fetchDetail).toHaveBeenCalledTimes(4);
  });
});
