/**
 * 发现型源（豆瓣[py] 等）的跨源自愈：真正判断「能播」而不是「搜到了」。
 *
 * 这些源自己没有 detailContent、也没有 searchContent，同站按名回查永远拿不到
 * 结果。回归最容易出现的是「只按片名命中就切源」——切过去依旧是空详情，
 * 用户还是被卡在错误页。这里锁住两条：候选必须过滤、详情必须带剧集。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./sourceCache", () => ({ ensureSources: vi.fn() }));
vi.mock("./invoke", () => ({ api: { detail: vi.fn() } }));

import { findPlayableSource } from "./crossSourceRecovery";
import { ensureSources } from "./sourceCache";
import { api } from "./invoke";
import type { SourceOption } from "./sources";
import type { Site } from "../types/luma";

const sites = [] as Site[];
const site = (key: string, changeable?: boolean) =>
  ({ key, changeable, enabled: true, runtime: "cms" }) as unknown as Site;
const option = (siteKey: string, vodId: string, matchScore = 3): SourceOption => ({
  siteKey,
  siteName: siteKey,
  vodId,
  vodName: "后会友期",
  matchScore,
});
const playable = [{ vod_play_from: "线路1", vod_play_url: "第1集$http://a/1.m3u8" }];
const empty = [{ vod_play_from: "", vod_play_url: "" }];

const mockView = (options: SourceOption[]) =>
  vi.mocked(ensureSources).mockResolvedValue({
    options,
    stats: { total: 0, ok: 0, failed: 0, skipped: 0, tookMs: 0, matched: options.length },
    origin: "prefetch",
    complete: true,
    pending: false,
    cached: true,
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findPlayableSource", () => {
  it("skips candidates whose detail has no play lines", async () => {
    mockView([option("a", "1"), option("b", "2"), option("c", "3")]);
    vi.mocked(api.detail)
      .mockResolvedValueOnce(empty as never)
      .mockResolvedValueOnce(playable as never);

    const result = await findPlayableSource("后会友期", sites, "py_douban");
    expect(result.found?.siteKey).toBe("b");
    expect(result.probed).toBeGreaterThanOrEqual(2);
  });

  it("filters out the current source, weak matches and empty ids", async () => {
    mockView([
      option("py_douban", "same"),
      option("weak", "w", 1),
      option("no-id", ""),
      option("good", "g"),
    ]);
    vi.mocked(api.detail).mockResolvedValue(playable as never);

    const result = await findPlayableSource("后会友期", sites, "py_douban");
    expect(result.found?.siteKey).toBe("good");
    expect(vi.mocked(api.detail).mock.calls.map((call) => call[0])).toEqual(["good"]);
  });

  it("skips sites that declare changeable=0 but keeps undeclared ones", async () => {
    mockView([option("locked", "1"), option("plain", "2")]);
    vi.mocked(api.detail).mockResolvedValue(playable as never);

    // `changeable: 0` 是源作者声明「别拿我换源」，TVBox 的候选筛选同样排除它。
    const result = await findPlayableSource(
      "后会友期",
      [site("locked", false), site("plain", true)],
      "py_douban",
    );
    expect(result.found?.siteKey).toBe("plain");
    expect(vi.mocked(api.detail).mock.calls.map((call) => call[0])).toEqual(["plain"]);
  });

  it("treats a site missing from the snapshot as changeable", async () => {
    // 旧快照没有 changeable 键、调用方也可能只传空数组：都不能因此丢候选。
    mockView([option("ghost", "1")]);
    vi.mocked(api.detail).mockResolvedValue(playable as never);

    const result = await findPlayableSource("后会友期", [], "py_douban");
    expect(result.found?.siteKey).toBe("ghost");
  });

  it("never calls ensureSources on an empty title or a dead page", async () => {
    expect(await findPlayableSource("", sites, "py_douban")).toEqual({ found: null, probed: 0 });
    expect(await findPlayableSource("后会友期", sites, "py_douban", () => false)).toEqual({
      found: null,
      probed: 0,
    });
    expect(ensureSources).not.toHaveBeenCalled();
  });

  it("returns no winner when every candidate is empty or throws", async () => {
    mockView([option("a", "1"), option("b", "2")]);
    vi.mocked(api.detail)
      .mockResolvedValueOnce(empty as never)
      .mockRejectedValueOnce(new Error("timeout"));

    const result = await findPlayableSource("后会友期", sites, "py_douban");
    expect(result.found).toBeNull();
    expect(result.probed).toBe(2);
  });
});
