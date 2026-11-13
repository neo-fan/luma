/**
 * 订阅自动刷新的展示层纯函数（`src/lib/config.ts`）。
 *
 * 这些文案是用户判断「到底有没有在刷新」的唯一线索，所以四种状态必须互斥、
 * 且不能把「从未检查」伪装成「刚刚」。
 */
import { describe, expect, it } from "vitest";
import { describeRefreshState, formatRelativeTime } from "../../src/lib/config";
import type { ConfigMeta } from "../../src/types/tvbox";

const NOW = new Date("2026-11-13T12:00:00Z").getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function meta(patch: Partial<ConfigMeta> = {}): ConfigMeta {
  return {
    id: "box",
    name: "box",
    source: { kind: "url", value: "https://example.com/box.json" },
    importedAt: "2026-11-01T00:00:00Z",
    refreshable: true,
    ...patch,
  };
}

describe("formatRelativeTime", () => {
  it("把毫秒差归成四档", () => {
    expect(formatRelativeTime(NOW - 5_000, NOW)).toBe("刚刚");
    expect(formatRelativeTime(NOW - 5 * MINUTE, NOW)).toBe("5 分钟前");
    expect(formatRelativeTime(NOW - 3 * HOUR, NOW)).toBe("3 小时前");
    expect(formatRelativeTime(NOW - 2 * 24 * HOUR, NOW)).toBe("2 天前");
  });

  it("未来时间与未知值不伪造成刚刚", () => {
    // 时钟回拨/服务端时间超前时差值为负，按「刚刚」处理而不是负数。
    expect(formatRelativeTime(NOW + 10_000, NOW)).toBe("刚刚");
    expect(formatRelativeTime(undefined, NOW)).toBe("—");
    expect(formatRelativeTime(0, NOW)).toBe("—");
  });
});

describe("describeRefreshState", () => {
  it("不可刷新的来源直接说明", () => {
    expect(
      describeRefreshState(meta({ refreshable: false, source: { kind: "file", value: "D:/box.json" } }), NOW),
    ).toBe("本地配置，不支持自动更新");
  });

  it("失败优先于「已是最新」", () => {
    expect(
      describeRefreshState(
        meta({ lastCheckedAt: NOW - 2 * MINUTE, refreshError: "fetch timeout" }),
        NOW,
      ),
    ).toBe("检查失败：fetch timeout");
  });

  it("从未检查过", () => {
    expect(describeRefreshState(meta(), NOW)).toBe("尚未检查更新");
  });

  it("检查过但没变化", () => {
    const state = describeRefreshState(
      meta({ lastCheckedAt: NOW - 10 * MINUTE, lastChangedAt: NOW - 3 * HOUR }),
      NOW,
    );
    expect(state).toBe("已是最新 · 10 分钟前检查");
  });

  it("这次检查带来了变化", () => {
    const state = describeRefreshState(
      meta({ lastCheckedAt: NOW - MINUTE, lastChangedAt: NOW - MINUTE }),
      NOW,
    );
    expect(state).toBe("已更新 1 分钟前");
  });
});
