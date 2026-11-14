/**
 * 播放错误文案：内部枚举名不该直接怼给用户。
 * `manifestParsingError` 的真实含义几乎总是「源返回的不是 m3u8」。
 */
import { describe, expect, it } from "vitest";
import { describeHlsError, isTimingFailure } from "./playErrors";

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

/**
 * 「时间型失败」不是「线路坏了」的证据。
 *
 * 慢源冷启（首个分片 9MB+ / 上游接口 18s）必然先触发这些 fatal，
 * 旧实现见到 fatal 就换线，用户看到的是「明明能播却被换走」。
 */
describe("isTimingFailure", () => {
  it("treats load timeouts and network stalls as non-evidence", () => {
    for (const details of [
      "manifestLoadError",
      "manifestLoadTimeOut",
      "levelLoadTimeOut",
      "fragLoadTimeOut",
      "keyLoadError",
      "bufferStalledError",
      "networkError",
    ]) {
      expect(isTimingFailure(details)).toBe(true);
    }
  });

  it("keeps content-level failures decisive", () => {
    for (const details of [
      "manifestParsingError",
      "levelParsingError",
      "fragParsingError",
      "bufferAddCodecError",
      "levelEmptyError",
    ]) {
      expect(isTimingFailure(details)).toBe(false);
    }
  });

  it("does not classify unknown or empty details", () => {
    expect(isTimingFailure(undefined)).toBe(false);
    expect(isTimingFailure("")).toBe(false);
    expect(isTimingFailure("someBrandNewError")).toBe(false);
  });
});
