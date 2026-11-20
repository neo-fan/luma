/**
 * 换集 / 换源共用的单集解析链。
 *
 * 守两条回归：① 命中集级缓存时不得再问源站（慢源的 3~18s 全在这一跳）；
 * ② 播放类型变化（`hls → page`）必须抛错而不是把地址交回去——原地换流遇到
 * 协议变化只会白屏，调用方要靠这个错退回整页重建。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const resolvePlay = vi.fn();
const resolveEpisodeTarget = vi.fn();

vi.mock("../../lib/invoke", () => ({
  api: { resolvePlay: (...args: unknown[]) => resolvePlay(...args) },
}));

vi.mock("../../lib/episodeResolve", () => ({
  resolveEpisodeTarget: (...args: unknown[]) => resolveEpisodeTarget(...args),
}));

const { resolveEpisodePlay } = await import("./episodePlayResolve");
const { clearEpisodePlayCache, setEpisodePlayCache } = await import(
  "../../lib/episodePlayCache"
);

const play = (kind: string, url = "http://127.0.0.1:9978/proxy?url=a.m3u8") => ({
  url,
  proxyUrl: url,
  kind,
  headers: [] as [string, string][],
});

afterEach(() => {
  clearEpisodePlayCache();
  resolvePlay.mockReset();
  resolveEpisodeTarget.mockReset();
});

describe("resolveEpisodePlay", () => {
  it("reuses the episode cache when the kind still matches", async () => {
    setEpisodePlayCache("s1", "线路一", "ep1", play("hls"));
    const resolved = await resolveEpisodePlay("s1", "线路一", "ep1", "hls");
    expect(resolved.kind).toBe("hls");
    expect(resolveEpisodeTarget).not.toHaveBeenCalled();
    expect(resolvePlay).not.toHaveBeenCalled();
  });

  it("re-resolves when the cached kind no longer matches the kernel", async () => {
    setEpisodePlayCache("s1", "线路一", "ep1", play("hls"));
    resolveEpisodeTarget.mockResolvedValue({ url: "https://cdn.example/1.m3u8" });
    resolvePlay.mockResolvedValue(play("flv"));
    const resolved = await resolveEpisodePlay("s1", "线路一", "ep1", "flv");
    expect(resolved.kind).toBe("flv");
    expect(resolvePlay).toHaveBeenCalledTimes(1);
  });

  it("resolves through playerContent and caches the result", async () => {
    resolveEpisodeTarget.mockResolvedValue({
      url: "https://cdn.example/1.m3u8",
      ua: "UA/1",
      referer: "https://cdn.example/",
    });
    resolvePlay.mockResolvedValue(play("hls"));
    await resolveEpisodePlay("s1", "线路一", "ep1", "hls");
    expect(resolvePlay).toHaveBeenCalledWith({
      siteKey: "s1",
      url: "https://cdn.example/1.m3u8",
      ua: "UA/1",
      referer: "https://cdn.example/",
      cookie: undefined,
    });
    // 第二次必须命中缓存：不再问源站。
    resolvePlay.mockClear();
    await resolveEpisodePlay("s1", "线路一", "ep1", "hls");
    expect(resolvePlay).not.toHaveBeenCalled();
  });

  it("throws on an unresolvable line without calling resolve_play", async () => {
    resolveEpisodeTarget.mockResolvedValue({ url: "CO4K_abc", unresolvable: true });
    await expect(resolveEpisodePlay("s1", "线路一", "ep1", "hls")).rejects.toThrow(
      "线路不可解析",
    );
    expect(resolvePlay).not.toHaveBeenCalled();
  });

  it("throws when the play kind changes or lands on a page", async () => {
    resolveEpisodeTarget.mockResolvedValue({ url: "https://cdn.example/p" });
    resolvePlay.mockResolvedValue(play("page", "https://cdn.example/p"));
    await expect(resolveEpisodePlay("s1", "线路一", "ep1", "hls")).rejects.toThrow(
      "播放类型变化",
    );
    await expect(resolveEpisodePlay("s1", "线路一", "ep1", "page")).rejects.toThrow(
      "播放类型变化",
    );
  });
});
