import { describe, expect, it } from "vitest";
import { episodePanelView } from "./catalogState";

describe("episodePanelView", () => {
  it("keeps the grid whenever lines are available, even while a refetch runs", () => {
    // 换源 / 重试在途（status=loading）不该把用户能点的剧集撤掉。
    expect(episodePanelView("loading", 2, 40)).toBe("grid");
  });

  it("keeps the grid even after a failed refetch", () => {
    // 目录数据已经在手，后来的补拉失败只该记在状态里，不该清屏。
    expect(episodePanelView("error", 1, 12)).toBe("grid");
  });

  it("shows loading only when there is nothing to show yet", () => {
    expect(episodePanelView("loading", 0, 0)).toBe("loading");
  });

  it("shows the error state when the catalog failed and no lines arrived", () => {
    expect(episodePanelView("error", 0, 0)).toBe("error");
  });

  it("treats a ready catalog without episodes as empty, not loading", () => {
    // 源站给了详情但播放串为空：这是确定的空结果，不能一直转圈。
    expect(episodePanelView("ready", 1, 0)).toBe("empty");
    expect(episodePanelView("ready", 0, 0)).toBe("empty");
  });
});
