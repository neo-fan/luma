import { describe, expect, it } from "vitest";
import { normalizeHeaders } from "./playHeaders";

describe("normalizeHeaders", () => {
  it("passes through a plain header object", () => {
    const headers = { "User-Agent": "Mozilla/5.0", Referer: "https://a.example" };
    expect(normalizeHeaders(headers)).toEqual(headers);
  });

  it("parses a JSON-string header (pianku 系源)", () => {
    const raw = JSON.stringify({ "User-Agent": "Mozilla/5.0", Referer: "https://4k01.pianku.online/" });
    expect(normalizeHeaders(raw)).toEqual({
      "User-Agent": "Mozilla/5.0",
      Referer: "https://4k01.pianku.online/",
    });
  });

  it("returns {} for null / undefined / empty string", () => {
    expect(normalizeHeaders(null)).toEqual({});
    expect(normalizeHeaders(undefined)).toEqual({});
    expect(normalizeHeaders("")).toEqual({});
  });

  it("returns {} for malformed JSON", () => {
    expect(normalizeHeaders("{not json}")).toEqual({});
  });

  it("returns {} for arrays (object or JSON-string form)", () => {
    expect(normalizeHeaders([["a", "b"]])).toEqual({});
    expect(normalizeHeaders(JSON.stringify(["a", "b"]))).toEqual({});
  });

  it("returns {} for a JSON scalar", () => {
    expect(normalizeHeaders(JSON.stringify(42))).toEqual({});
  });
});
