/**
 * `vod_play_url` → 真实播放地址的编排规则（playerContent 优先）。
 *
 * 这里守的是回归：详情里的 `PAN1-7vpup…` / `zijianm3u8-…` 不是 URL，必须交给
 * 对应线路的 playerContent；一旦某个调用点（换线路 / 换源探测）绕开它，就会
 * 出现「11 条 play url is invalid，且真正可播的线路被跳过」。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const spiderInvoke = vi.fn();
const parseResolve = vi.fn();

vi.mock("../../src/lib/invoke", () => ({
  api: {
    spiderInvoke: (...args: unknown[]) => spiderInvoke(...args),
    parseResolve: (...args: unknown[]) => parseResolve(...args),
  },
  errorMessage: (err: unknown) => String(err),
}));

const { resolveEpisodeTarget } = await import("../../src/lib/episodeResolve");

afterEach(() => {
  spiderInvoke.mockReset();
  parseResolve.mockReset();
});

describe("resolveEpisodeTarget", () => {
  it("skips playerContent when the line name is unknown", async () => {
    const target = await resolveEpisodeTarget("py_x", undefined, "PAN1-abc");
    expect(target).toEqual({ url: "PAN1-abc" });
    expect(spiderInvoke).not.toHaveBeenCalled();
  });

  it("turns a private token into the direct url and keeps the line headers", async () => {
    spiderInvoke.mockResolvedValue({
      url: "http://43.248.3.46:7788/m3u8/pan1.php?token=t.m3u8",
      parse: 0,
      header: { Referer: "http://43.248.3.46:7788", "User-Agent": "UA/1" },
    });
    const target = await resolveEpisodeTarget("py_bubuzhuiju", "PAN1", "PAN1-7vpup");
    expect(target.url).toBe("http://43.248.3.46:7788/m3u8/pan1.php?token=t.m3u8");
    expect(target.referer).toBe("http://43.248.3.46:7788");
    expect(target.ua).toBe("UA/1");
  });

  it("routes parse=1 through the parse pool and reports the parser", async () => {
    spiderInvoke.mockResolvedValue({ url: "https://page.example/p/1", parse: 1 });
    parseResolve.mockResolvedValue({
      url: "https://cdn.example/index.m3u8",
      parser: "json-probe",
      headers: [["Referer", "https://cdn.example/"]],
    });
    const target = await resolveEpisodeTarget("s1", "线路1", "abc123");
    expect(parseResolve).toHaveBeenCalledTimes(1);
    expect(target.url).toBe("https://cdn.example/index.m3u8");
    expect(target.parser).toBe("json-probe");
    expect(target.referer).toBe("https://cdn.example/");
  });

  it("falls back to the playerContent url when the parse pool fails", async () => {
    spiderInvoke.mockResolvedValue({ url: "https://page.example/p/1", jx: 1 });
    parseResolve.mockRejectedValue(new Error("all parsers failed"));
    const target = await resolveEpisodeTarget("s1", "线路1", "abc123");
    expect(target.url).toBe("https://page.example/p/1");
  });

  it("keeps local proxy urls untouched", async () => {
    spiderInvoke.mockResolvedValue({ url: "http://127.0.0.1:9978/proxy?do=py&x=1", parse: 1 });
    const target = await resolveEpisodeTarget("s1", "线路1", "abc");
    expect(target.url).toBe("http://127.0.0.1:9978/proxy?do=py&x=1");
    expect(parseResolve).not.toHaveBeenCalled();
  });

  it("keeps the original url when the spider throws", async () => {
    spiderInvoke.mockRejectedValue(new Error("method not implemented"));
    const target = await resolveEpisodeTarget("cms1", "线路1", "https://cdn.example/a.m3u8");
    expect(target).toEqual({ url: "https://cdn.example/a.m3u8" });
  });

  it("keeps the original url when playerContent returns nothing usable", async () => {
    spiderInvoke.mockResolvedValue({ url: "", header: { Referer: "http://r/" } });
    const target = await resolveEpisodeTarget("s1", "线路1", "weiguan://abc");
    expect(target.url).toBe("weiguan://abc");
    expect(target.referer).toBe("http://r/");
  });

  it("accepts a JSON-string header from pianku-like sources", async () => {
    spiderInvoke.mockResolvedValue({
      url: "https://cdn.example/a.m3u8",
      header: '{"User-Agent":"UA/2","Cookie":"c=1"}',
    });
    const target = await resolveEpisodeTarget("s1", "线路1", "abc");
    expect(target.ua).toBe("UA/2");
    expect(target.cookie).toBe("c=1");
  });
});
