import { describe, expect, it } from "vitest";
import { formatBufferedSeconds, formatBytesPerSec } from "./bytes";

describe("formatBytesPerSec", () => {
  it("hides zero and junk so the HUD renders nothing", () => {
    expect(formatBytesPerSec(0)).toBe("");
    expect(formatBytesPerSec(-1)).toBe("");
    expect(formatBytesPerSec(Number.NaN)).toBe("");
  });

  it("keeps the unit that matches the magnitude", () => {
    expect(formatBytesPerSec(820)).toBe("820 B/s");
    expect(formatBytesPerSec(2048)).toBe("2 KB/s");
    expect(formatBytesPerSec(3.2 * 1024 * 1024)).toBe("3.2 MB/s");
  });
});

describe("formatBufferedSeconds", () => {
  it("uses seconds under a minute and m:ss above", () => {
    expect(formatBufferedSeconds(0)).toBe("");
    expect(formatBufferedSeconds(8.4)).toBe("8s");
    expect(formatBufferedSeconds(65)).toBe("1:05");
  });
});
