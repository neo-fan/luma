import { describe, expect, it } from "vitest";
import { detailTargetFor, resolvePlayRecord } from "./playbackTarget";

const fav = { siteKey: "srcA", vodId: "10", name: "庆余年" };

describe("playback target", () => {
  it("收藏落后于历史时，导航到历史那条源（播放数据以历史为准）", () => {
    const history = [
      { siteKey: "srcB", vodId: "99", name: "庆余年" },
      { siteKey: "srcC", vodId: "7", name: "别的剧" },
    ];
    expect(detailTargetFor(fav, history)).toEqual({
      name: "detail",
      siteKey: "srcB",
      vodId: "99",
      title: "庆余年",
    });
  });

  it("从没看过（历史没有该剧）→ 用收藏自身的源", () => {
    const history = [{ siteKey: "srcB", vodId: "99", name: "别的剧" }];
    expect(detailTargetFor(fav, history)).toEqual({
      name: "detail",
      siteKey: "srcA",
      vodId: "10",
      title: "庆余年",
    });
  });

  it("从历史条目进入（它本身就是历史行）→ 原样，行为不变", () => {
    const history = [{ siteKey: "srcB", vodId: "99", name: "庆余年" }];
    const hit = resolvePlayRecord(history[0], history);
    expect(hit).toBe(history[0]);
  });

  it("剧名空白 → 回退条目自身，不做匹配", () => {
    const blank = { siteKey: "srcA", vodId: "10", name: "  " };
    expect(resolvePlayRecord(blank, [{ siteKey: "x", vodId: "y", name: "" }])).toBe(blank);
  });
});
