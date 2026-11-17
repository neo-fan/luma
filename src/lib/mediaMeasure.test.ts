import { describe, expect, it } from "vitest";
import { hasMediaStopped, smoothBitrate } from "./mediaMeasure";

describe("smoothBitrate", () => {
  it("第一个样本直接采用，不做平滑", () => {
    expect(smoothBitrate(0, 2000).kbps).toBe(2000);
  });

  it("后续按 0.7/0.3 平滑：片头小分片不会把读数带飞", () => {
    expect(smoothBitrate(2000, 500).kbps).toBeCloseTo(1550, 5);
  });

  it("抖动小于 10% 不重渲染", () => {
    const r = smoothBitrate(2000, 2010);
    expect(r.changed).toBe(false);
  });

  it("换档那一跳要立刻反映", () => {
    expect(smoothBitrate(2000, 6000).changed).toBe(true);
  });

  it("读数为 0 时不除零", () => {
    expect(() => smoothBitrate(0, 0)).not.toThrow();
    expect(smoothBitrate(0, 0).kbps).toBe(0);
  });
});

describe("hasMediaStopped", () => {
  it("暂停态：缓冲不足才算停，有缓冲就还在解码", () => {
    expect(hasMediaStopped({ paused: true, readyState: 1, currentTime: 10, startedAt: 10 })).toBe(true);
    expect(hasMediaStopped({ paused: true, readyState: 2, currentTime: 10, startedAt: 10 })).toBe(false);
  });

  it("播放态：时钟没推进才算停", () => {
    expect(hasMediaStopped({ paused: false, readyState: 4, currentTime: 10, startedAt: 10 })).toBe(true);
    expect(hasMediaStopped({ paused: false, readyState: 4, currentTime: 10.1, startedAt: 10 })).toBe(true);
    expect(hasMediaStopped({ paused: false, readyState: 4, currentTime: 10.5, startedAt: 10 })).toBe(false);
  });

  it("0.2s 容差边界", () => {
    expect(hasMediaStopped({ paused: false, readyState: 4, currentTime: 10.2, startedAt: 10 })).toBe(true);
    expect(hasMediaStopped({ paused: false, readyState: 4, currentTime: 10.21, startedAt: 10 })).toBe(false);
  });
});
