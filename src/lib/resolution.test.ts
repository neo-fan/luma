/**
 * 分辨率标签：站点不提供结构化分辨率，只能从解码尺寸 / HLS 声明值反推。
 *
 * 这里的用例锁住三件事：常见档位归一化、竖屏取短边、以及「没数值就不渲染」
 * （返回空串由组件整块隐藏，而不是显示 "0P" 这种垃圾文案）。
 */
import { describe, expect, it } from "vitest";
import {
  remarksResolution,
  resolutionBadge,
  resolutionDetail,
  resolutionFromVideo,
  resolutionLabel,
} from "./resolution";

describe("resolutionLabel", () => {
  it("只出 720P / 1080P / 2K / 4K 四档", () => {
    expect(resolutionLabel(1920, 1080)).toBe("1080P");
    expect(resolutionLabel(1280, 720)).toBe("720P");
    expect(resolutionLabel(2560, 1440)).toBe("2K");
    expect(resolutionLabel(3840, 2160)).toBe("4K");
  });

  it("竖屏取短边，不会因为宽度小就报低清", () => {
    expect(resolutionLabel(1080, 1920)).toBe("1080P");
    expect(resolutionLabel(720, 1280)).toBe("720P");
  });

  it("低于 720P 直接给精确尺寸，尺寸缺失返回空串", () => {
    expect(resolutionLabel(854, 480)).toBe("854×480");
    expect(resolutionLabel(640, 360)).toBe("640×360");
    expect(resolutionLabel(0, 0)).toBe("");
    expect(resolutionLabel(1920, 0)).toBe("");
    expect(resolutionLabel(Number.NaN, 1080)).toBe("");
  });
});

describe("resolutionDetail", () => {
  it("给出精确像素，供 tooltip 用", () => {
    expect(resolutionDetail(1920, 1080)).toBe("1920 × 1080");
    expect(resolutionDetail(0, 1080)).toBe("");
  });
});

describe("resolutionBadge", () => {
  it("优先真实解码尺寸", () => {
    expect(resolutionBadge({ width: 1920, height: 1080, declaredHeight: 720 })).toBe("1080P");
  });

  it("没有解码尺寸时退回 HLS 清单声明值", () => {
    expect(resolutionBadge({ width: 0, height: 0, declaredHeight: 1080 })).toBe("1080P");
    expect(resolutionBadge({ width: 0, height: 0, declaredHeight: 1440 })).toBe("2K");
    expect(resolutionBadge({ width: 0, height: 0, declaredHeight: 2160 })).toBe("4K");
    // 非标准声明高度仍归到档位。
    expect(resolutionBadge({ width: 0, height: 0, declaredHeight: 1078 })).toBe("1080P");
  });

  it("两处都没有就返回空串，组件不渲染", () => {
    expect(resolutionBadge({ width: 0, height: 0 })).toBe("");
    expect(resolutionBadge({ width: 0, height: 0, declaredHeight: 0 })).toBe("");
  });
});

describe("remarksResolution", () => {  it("只认显式写出的清晰度", () => {
    expect(remarksResolution("1080P")).toBe("1080P");
    expect(remarksResolution("更新至12集 720P")).toBe("720P");
    expect(remarksResolution("4K 高清")).toBe("4K");
    expect(remarksResolution("2160P")).toBe("4K");
  });

  it("运营文案里的「已完结 / HD」不当作分辨率", () => {
    expect(remarksResolution("已完结")).toBe("");
    expect(remarksResolution("HD")).toBe("");
    expect(remarksResolution("")).toBe("");
    expect(remarksResolution(null)).toBe("");
  });
});

describe("resolutionFromVideo", () => {
  it("直接读 <video> 的解码尺寸（历史写入走这条路径）", () => {
    const video = (width: number, height: number) =>
      ({ videoWidth: width, videoHeight: height }) as unknown as HTMLVideoElement;
    expect(resolutionFromVideo(video(1920, 1080))).toBe("1080P");
    expect(resolutionFromVideo(video(3840, 2160))).toBe("4K");
    // 还没出画：返回空串，调用方保留上一次的已知值。
    expect(resolutionFromVideo(video(0, 0))).toBe("");
    expect(resolutionFromVideo(null)).toBe("");
  });
});
