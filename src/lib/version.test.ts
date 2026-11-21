import { describe, expect, it } from "vitest";
import { compareVersions, isVersionAtLeast } from "./version";

describe("version compare: update receipt", () => {
  it("compares numeric parts and treats missing parts as zero", () => {
    expect(compareVersions("2.0.2", "2.0.2")).toBe(0);
    expect(compareVersions("2.0", "2.0.0")).toBe(0);
    expect(compareVersions("2.0.3", "2.0.2")).toBeGreaterThan(0);
    expect(compareVersions("2.1.0", "2.0.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.1", "2.0.2")).toBeLessThan(0);
  });

  it("ignores v prefix and prerelease suffix", () => {
    expect(compareVersions("v2.0.2", "2.0.2")).toBe(0);
    expect(compareVersions("2.0.2-beta.1", "2.0.2")).toBe(0);
    expect(compareVersions("v2.0.2+build.7", "2.0.2")).toBe(0);
  });

  it("reports whether the installed version reached the pending target", () => {
    expect(isVersionAtLeast("2.0.2", "2.0.2")).toBe(true);
    expect(isVersionAtLeast("2.0.3", "2.0.2")).toBe(true);
    expect(isVersionAtLeast("2.0.1", "2.0.2")).toBe(false);
    expect(isVersionAtLeast("", "2.0.2")).toBe(false);
  });
});
