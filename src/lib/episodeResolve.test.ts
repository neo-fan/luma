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

vi.mock("./invoke", () => ({
  api: {
    spiderInvoke: (...args: unknown[]) => spiderInvoke(...args),
    parseResolve: (...args: unknown[]) => parseResolve(...args),
  },
  errorMessage: (err: unknown) => String(err),
}));

const { resolveEpisodeTarget } = await import("./episodeResolve");

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

  it("marks netdisk tokens the spider echoes back as unresolvable", async () => {
    // 布布追剧 CO4K / qsvip / jjkk 线路：playerContent 把 token 原样吐回来，
    // 交给 resolve_play 只会得到 "play url is invalid"。
    spiderInvoke.mockResolvedValue({ url: "CO4K_abc%2FX", parse: 0, header: {} });
    const target = await resolveEpisodeTarget("py_bubuzhuiju", "CO4K", "CO4K_abc%2FX");
    expect(target.unresolvable).toBe(true);
    expect(target.rejected).toBe(true);
    expect(target.url).toBe("CO4K_abc%2FX");
  });

  it("treats an empty playerContent result for a private token as a source rejection", async () => {
    // zijianm3u8 实测：站点回「线路暂时停用 / 无可用套餐」，源只能把 token 吐回。
    // 这不是超时，也不是永久坏线路——要标成 rejected，好让上层给出重试文案。
    spiderInvoke.mockResolvedValue({ url: "", parse: 0, header: {} });
    const target = await resolveEpisodeTarget("py_bubuzhuiju", "zijianm3u8", "zijian_abc");
    expect(target.unresolvable).toBe(true);
    expect(target.rejected).toBe(true);
    expect(target.timedOut).toBeFalsy();
  });

  it("does not mark a real http url as unresolvable", async () => {
    spiderInvoke.mockResolvedValue({ url: "", parse: 0 });
    const target = await resolveEpisodeTarget("s1", "线路1", "https://cdn.example/a.m3u8");
    expect(target.unresolvable).toBeFalsy();
    expect(target.url).toBe("https://cdn.example/a.m3u8");
  });

  it("passes the default 8s timeout, and the caller-provided one for slow sources", async () => {
    spiderInvoke.mockResolvedValue({ url: "https://cdn.example/a.m3u8", parse: 0 });
    // 探测/换线链路：缺省 8s。
    await resolveEpisodeTarget("s1", "线路1", "tok1");
    expect(spiderInvoke).toHaveBeenLastCalledWith({
      siteKey: "s1",
      method: "playerContent",
      args: ["线路1", "tok1", []],
      timeoutMs: 8_000,
    });
    // 用户手选线路首播：慢源（多多影院 ZJ4K 实测 4~5s、忙时越过 8s）放宽到 15s。
    await resolveEpisodeTarget("s1", "线路1", "tok2", { playerContentTimeoutMs: 15_000 });
    expect(spiderInvoke).toHaveBeenLastCalledWith({
      siteKey: "s1",
      method: "playerContent",
      args: ["线路1", "tok2", []],
      timeoutMs: 15_000,
    });
  });
});
