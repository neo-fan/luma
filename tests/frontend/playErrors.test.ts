/**
 * 播放错误文案：内部枚举名不该直接怼给用户。
 * `manifestParsingError` 的真实含义几乎总是「源返回的不是 m3u8」。
 */
import { describe, expect, it } from "vitest";
import { describeHlsError } from "../../src/lib/playErrors";

describe("describeHlsError", () => {
  it("explains a manifest that is not a playlist", () => {
    expect(describeHlsError("manifestParsingError")).toContain("不是 m3u8");
  });

  it("explains dead sources and anti-leech rejections", () => {
    expect(describeHlsError("manifestLoadError")).toContain("不可达");
    expect(describeHlsError("keyLoadError")).toContain("防盗链");
  });

  it("falls back to the raw enum so real source issues stay diagnosable", () => {
    expect(describeHlsError("someBrandNewError")).toBe("someBrandNewError");
  });

  it("never returns an empty string", () => {
    expect(describeHlsError(undefined)).toBe("未知错误");
    expect(describeHlsError("")).toBe("未知错误");
  });
});
