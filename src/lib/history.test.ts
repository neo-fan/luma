import { describe, expect, it } from "vitest";
import { historySubtitle, progressText, relativeTime } from "./history";
import type { HistoryItem } from "../types/tvbox";

const base: HistoryItem = {
  siteKey: "cms",
  vodId: "1",
  name: "庆余年",
  siteName: "量子",
  playUrl: "http://a/3.m3u8",
  episodeName: "第 3 集",
  playFrom: "线路A",
  positionMs: 600_000,
  durationMs: 1_200_000,
  updatedAt: 1_000_000,
};

describe("progressText", () => {
  it("renders a percentage when the duration is known", () => {
    expect(progressText(base)).toBe("已看 50%");
  });

  it("caps at 99% so a finished item never looks complete", () => {
    expect(progressText({ positionMs: 1_200_000, durationMs: 1_200_000 })).toBe("已看 99%");
  });

  it("falls back to watched seconds without a duration", () => {
    expect(progressText({ positionMs: 65_000, durationMs: 0 })).toBe("已看 65 秒");
    expect(progressText({ positionMs: 0, durationMs: 0 })).toBe("");
  });
});

describe("relativeTime", () => {
  const now = new Date(2026, 1, 1, 12, 0, 0).getTime();

  it("formats recent stamps", () => {
    expect(relativeTime(now - 30_000, now)).toBe("刚刚");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 小时前");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2 天前");
  });

  it("switches to a date after a week and hides a missing stamp", () => {
    expect(relativeTime(new Date(2026, 0, 5).getTime(), now)).toBe("2026-01-05");
    expect(relativeTime(0, now)).toBe("");
  });
});

describe("historySubtitle", () => {
  it("includes the line and episode recorded by the player", () => {
    const sub = historySubtitle({ ...base, updatedAt: 1_000_000 }, 1_060_000);
    expect(sub).toBe("量子 · 线路 线路A · 看到 第 3 集 · 已看 50% · 1 分钟前");
  });

  it("keeps old rows readable when line/episode are absent", () => {
    const legacy = { ...base, playFrom: undefined, episodeName: undefined, siteName: undefined };
    expect(historySubtitle(legacy, 1_060_000)).toBe("cms · 已看 50% · 1 分钟前");
  });
});
