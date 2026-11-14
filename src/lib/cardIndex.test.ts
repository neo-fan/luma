/**
 * 列表卡片索引（`src/lib/cardIndex.ts`）：详情页在「源不提供详情」时靠它
 * 回填海报/片名/评分。
 *
 * 这套机制对应 TVBox 侧的 `Vod.checkPic / checkName`——详情字段为空就用列表
 * 卡片兜底，只不过我们发现/推荐型源连详情对象都没有，兜底范围要更大。
 *
 * 测试重点放在「不能串站」「不能无限增长」和「只存轻字段」：这三条错了会
 * 分别表现为「点 A 站看到 B 站的海报」「长逛内存涨」和「详情页拿到旧播放串」。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  cardIndexSize,
  forgetCards,
  recallCard,
  rememberCards,
} from "./cardIndex";
import type { VodInfo } from "../types/tvbox";

function vod(id: string, name: string, patch: Partial<VodInfo> = {}): VodInfo {
  return {
    vod_id: id,
    vod_name: name,
    vod_pic: `https://img/${id}.jpg`,
    vod_remarks: "电影评分 8.2",
    vod_year: "2026中国大陆",
    vod_play_from: "线路一",
    vod_play_url: `第1集$${id}-1.m3u8`,
    ...patch,
  };
}

afterEach(() => {
  forgetCards();
});

describe("cardIndex", () => {
  it("records a card and recalls the fields a detail page needs", () => {
    rememberCards("py_douban", [vod("37100984", "后会友期")]);
    const hit = recallCard("py_douban", "37100984");
    expect(hit).not.toBeNull();
    expect(hit?.vod_name).toBe("后会友期");
    expect(hit?.vod_pic).toBe("https://img/37100984.jpg");
    expect(hit?.vod_remarks).toBe("电影评分 8.2");
    expect(hit?.vod_year).toBe("2026中国大陆");
  });

  it("keeps only light fields so a browse session cannot pin playback strings", () => {
    rememberCards("py_douban", [vod("1", "甲")]);
    const hit = recallCard("py_douban", "1");
    // 播放串在详情页毫无用处：它有播放串就不该走空态分支。
    expect(hit?.vod_play_url).toBe("");
    expect(hit?.vod_play_from).toBe("");
  });

  it("does not mix cards across sites with the same id", () => {
    rememberCards("site_a", [vod("100", "甲站影片")]);
    rememberCards("site_b", [vod("100", "乙站影片")]);
    expect(recallCard("site_a", "100")?.vod_name).toBe("甲站影片");
    expect(recallCard("site_b", "100")?.vod_name).toBe("乙站影片");
    expect(recallCard("site_c", "100")).toBeNull();
  });

  it("skips entries without an id (detail is always looked up by id)", () => {
    rememberCards("py_douban", [vod("", "没有 id"), vod("  ", "空白 id"), vod("9", "有 id")]);
    expect(cardIndexSize()).toBe(1);
    expect(recallCard("py_douban", "9")?.vod_name).toBe("有 id");
  });

  it("tolerates empty / missing lists", () => {
    expect(() => rememberCards("py_douban", [])).not.toThrow();
    expect(() => rememberCards("py_douban", null)).not.toThrow();
    expect(() => rememberCards("py_douban", undefined)).not.toThrow();
    expect(() => rememberCards("", [vod("1", "甲")])).not.toThrow();
    expect(cardIndexSize()).toBe(0);
  });

  it("forgets one site or everything", () => {
    rememberCards("site_a", [vod("1", "甲")]);
    rememberCards("site_b", [vod("2", "乙")]);
    forgetCards("site_a");
    expect(recallCard("site_a", "1")).toBeNull();
    expect(recallCard("site_b", "2")).not.toBeNull();
    forgetCards();
    expect(cardIndexSize()).toBe(0);
  });

  it("caps its size, dropping the oldest cards first", () => {
    // 上限是 3000：这里多塞 5 条，断言淘汰的是最早写入的那几条。
    const list = Array.from({ length: 3005 }, (_, index) => vod(`id${index}`, `片${index}`));
    rememberCards("py_douban", list);
    expect(cardIndexSize()).toBe(3000);
    expect(recallCard("py_douban", "id0")).toBeNull();
    expect(recallCard("py_douban", "id3004")).not.toBeNull();
  });

  it("re-recording an existing card refreshes its recency", () => {
    rememberCards("py_douban", [vod("1", "甲")]);
    rememberCards("py_douban", [vod("2", "乙")]);
    // 重新记一次「甲」：它应该回到队尾，而不是在下一步扩容时被当成最旧淘汰。
    rememberCards("py_douban", [vod("1", "甲")]);
    // 先填到刚好 3000，再多 1 条触发淘汰：被淘汰的应当是最早的「乙」。
    const filler = Array.from({ length: 2998 }, (_, index) => vod(`x${index}`, `填充${index}`));
    rememberCards("py_douban", filler);
    rememberCards("py_douban", [vod("overflow", "溢出")]);
    expect(cardIndexSize()).toBe(3000);
    expect(recallCard("py_douban", "1")).not.toBeNull();
    expect(recallCard("py_douban", "2")).toBeNull();
  });
});
