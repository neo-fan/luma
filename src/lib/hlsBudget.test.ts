import { describe, expect, it } from "vitest";
import { hlsLoadBudget } from "./hlsBudget";

describe("hls load budget", () => {
  it("清单与层级超时宽容到 20s（慢源冷启不该被当 fatal）", () => {
    for (const isLive of [true, false]) {
      const b = hlsLoadBudget(isLive);
      expect(b.manifestLoadingTimeOut).toBe(20_000);
      expect(b.levelLoadingTimeOut).toBe(20_000);
      expect(b.manifestLoadingMaxRetry).toBe(3);
    }
  });

  it("分片超时按模式分档：直播快暴露，点播宽容大分片", () => {
    expect(hlsLoadBudget(true).fragLoadingTimeOut).toBe(20_000);
    expect(hlsLoadBudget(false).fragLoadingTimeOut).toBe(45_000);
  });

  it("重试都带固定间隔，避免慢源被密集重刷", () => {
    const b = hlsLoadBudget(false);
    expect(b.manifestLoadingRetryDelay).toBe(1_000);
    expect(b.fragLoadingRetryDelay).toBe(1_000);
    expect(b.fragLoadingMaxRetry).toBe(4);
  });
});
