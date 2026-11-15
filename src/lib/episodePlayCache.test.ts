/**
 * 按集播放解析缓存：命中跳过整条 playerContent → resolve_play 解析链。
 *
 * 重点盯三件事：TTL 过期不能把失效直链继续喂给播放器；key 必须区分
 * 站点 / 线路 / 集（同一集不同线路是不同 token）；fatal 后 invalidate
 * 必须精确命中，坏地址不能被下一轮命中。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  EPISODE_PLAY_CACHE_MAX,
  EPISODE_PLAY_TTL_MS,
  clearEpisodePlayCache,
  getEpisodePlayCache,
  invalidateEpisodePlayCache,
  setEpisodePlayCache,
} from "./episodePlayCache";
import type { PlayResolved } from "../types/luma";

function resolved(url: string, kind = "hls"): PlayResolved {
  return { url, proxyUrl: `http://127.0.0.1:9978/proxy?url=${encodeURIComponent(url)}`, kind, headers: [] };
}

beforeEach(() => {
  clearEpisodePlayCache();
});

describe("episodePlayCache", () => {
  it("命中返回同一份解析结果，未写入的集不命中", () => {
    const now = 1_000_000;
    const play = resolved("https://cdn/a.m3u8");
    setEpisodePlayCache("siteA", "PAN1", "ep1-token", play, now);
    expect(getEpisodePlayCache("siteA", "PAN1", "ep1-token", now + 1000)).toBe(play);
    expect(getEpisodePlayCache("siteA", "PAN1", "ep2-token", now + 1000)).toBeNull();
  });

  it("TTL 内命中，过期后不命中（失效直链不能继续喂给播放器）", () => {
    const now = 1_000_000;
    setEpisodePlayCache("s", "l", "ep", resolved("https://cdn/a.m3u8"), now);
    expect(getEpisodePlayCache("s", "l", "ep", now + EPISODE_PLAY_TTL_MS)).not.toBeNull();
    expect(getEpisodePlayCache("s", "l", "ep", now + EPISODE_PLAY_TTL_MS + 1)).toBeNull();
    // 过期条目顺手清掉：再写新值不受旧时间戳影响。
    setEpisodePlayCache("s", "l", "ep", resolved("https://cdn/b.m3u8"), now + EPISODE_PLAY_TTL_MS + 2);
    expect(getEpisodePlayCache("s", "l", "ep", now + EPISODE_PLAY_TTL_MS + 3)?.url).toBe("https://cdn/b.m3u8");
  });

  it("key 区分站点 / 线路 / 集；playFrom 缺省与空串同键", () => {
    const now = 1_000_000;
    setEpisodePlayCache("siteA", "PAN1", "ep", resolved("https://cdn/a.m3u8"), now);
    expect(getEpisodePlayCache("siteB", "PAN1", "ep", now)).toBeNull();
    expect(getEpisodePlayCache("siteA", "PAN2", "ep", now)).toBeNull();
    expect(getEpisodePlayCache("siteA", "PAN1", "ep-other", now)).toBeNull();

    setEpisodePlayCache("live", undefined, "channel-url", resolved("https://cdn/live.flv", "flv"), now);
    expect(getEpisodePlayCache("live", "", "channel-url", now)).not.toBeNull();
  });

  it("invalidate 精确作废一条，不影响其它集", () => {
    const now = 1_000_000;
    setEpisodePlayCache("s", "l", "ep1", resolved("https://cdn/1.m3u8"), now);
    setEpisodePlayCache("s", "l", "ep2", resolved("https://cdn/2.m3u8"), now);
    invalidateEpisodePlayCache("s", "l", "ep1");
    expect(getEpisodePlayCache("s", "l", "ep1", now)).toBeNull();
    expect(getEpisodePlayCache("s", "l", "ep2", now)).not.toBeNull();
    // 作废不存在的 key 不抛错（刷新 / fatal 路径可能重复作废）。
    expect(() => invalidateEpisodePlayCache("s", "l", "never")).not.toThrow();
  });

  it("容量上限 FIFO：超限时淘汰最旧，重复写入刷新到队尾", () => {
    const now = 1_000_000;
    for (let i = 0; i < EPISODE_PLAY_CACHE_MAX; i += 1) {
      setEpisodePlayCache("s", "l", `ep${i}`, resolved(`https://cdn/${i}.m3u8`), now + i);
    }
    // 第 0 条此刻最旧；重新写一次把它挪到队尾，再写一条触发淘汰。
    setEpisodePlayCache("s", "l", "ep0", resolved("https://cdn/0-new.m3u8"), now + 1000);
    setEpisodePlayCache("s", "l", "overflow", resolved("https://cdn/x.m3u8"), now + 1001);
    expect(getEpisodePlayCache("s", "l", "ep1", now + 1002)).toBeNull();
    expect(getEpisodePlayCache("s", "l", "ep0", now + 1002)?.url).toBe("https://cdn/0-new.m3u8");
    expect(getEpisodePlayCache("s", "l", "overflow", now + 1002)).not.toBeNull();
    expect(getEpisodePlayCache("s", "l", `ep${EPISODE_PLAY_CACHE_MAX - 1}`, now + 1002)).not.toBeNull();
  });

  it("page/share 这类不可内置解码的结论不入缓存", () => {
    const now = 1_000_000;
    setEpisodePlayCache("s", "l", "ep", resolved("https://share/page", "page"), now);
    setEpisodePlayCache("s", "l", "ep2", resolved("https://share/page2", "share"), now);
    expect(getEpisodePlayCache("s", "l", "ep", now)).toBeNull();
    expect(getEpisodePlayCache("s", "l", "ep2", now)).toBeNull();
  });

  it("clear 清空全部（单测隔离）", () => {
    const now = 1_000_000;
    setEpisodePlayCache("s", "l", "ep", resolved("https://cdn/a.m3u8"), now);
    clearEpisodePlayCache();
    expect(getEpisodePlayCache("s", "l", "ep", now)).toBeNull();
  });
});