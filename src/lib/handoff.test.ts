import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAllHandoffs,
  clearHandoff,
  peekDetailSeed,
  peekPlaySeed,
  putDetailSeed,
  putPlaySeed,
} from "./handoff";
import type { VodInfo } from "../types/luma";

function vod(id: string, name = `片${id}`): VodInfo {
  return {
    vod_id: id,
    vod_name: name,
    vod_pic: "https://img.test/p.jpg",
    vod_play_from: "",
    vod_play_url: "",
  };
}

beforeEach(() => {
  clearAllHandoffs();
  vi.useRealTimers();
});

describe("handoff", () => {
  it("详情种子按 siteKey+vodId 交接，身份不符当没有", () => {
    putDetailSeed("site_a", vod("1"));
    expect(peekDetailSeed("site_a", "1")?.vod_name).toBe("片1");
    // 同 id 不同源、同源不同 id 都不能命中：否则会把别的片的封面/片名顶上去。
    expect(peekDetailSeed("site_b", "1")).toBeNull();
    expect(peekDetailSeed("site_a", "2")).toBeNull();
  });

  it("peek 不消费：StrictMode 双跑初始化器两次都拿得到", () => {
    putDetailSeed("site_a", vod("1"));
    expect(peekDetailSeed("site_a", "1")).not.toBeNull();
    expect(peekDetailSeed("site_a", "1")).not.toBeNull();
  });

  it("播放种子按 playUrl 区分：同剧换集不会串", () => {
    putPlaySeed("site_a", vod("1"), "https://cdn/1.m3u8");
    expect(peekPlaySeed("site_a", "1", "https://cdn/1.m3u8")?.vod_name).toBe("片1");
    // vodId 相同、集地址不同 = 另一次交接，不能把上一集的实体交出去。
    expect(peekPlaySeed("site_a", "1", "https://cdn/2.m3u8")).toBeNull();
  });

  it("过期后不再返回（隔几分钟再回来按没有处理）", () => {
    vi.useFakeTimers();
    putDetailSeed("site_a", vod("1"));
    vi.advanceTimersByTime(3 * 60_000);
    expect(peekDetailSeed("site_a", "1")).toBeNull();
  });

  it("清除按身份进行，不会顺手抹掉另一次导航的交接", () => {
    putDetailSeed("site_a", vod("1"));
    clearHandoff("detail", "site_a|2");
    expect(peekDetailSeed("site_a", "1")).not.toBeNull();
    clearHandoff("detail", "site_a|1");
    expect(peekDetailSeed("site_a", "1")).toBeNull();
  });

  it("两类交接互不影响", () => {
    putDetailSeed("site_a", vod("1"));
    putPlaySeed("site_a", vod("1"), "https://cdn/1.m3u8");
    clearHandoff("play");
    expect(peekPlaySeed("site_a", "1", "https://cdn/1.m3u8")).toBeNull();
    expect(peekDetailSeed("site_a", "1")).not.toBeNull();
  });
});