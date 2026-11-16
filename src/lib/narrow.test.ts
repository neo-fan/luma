/**
 * 运行态窄化守卫层的行为契约（src/lib/invoke.ts）。
 *
 * 这里只测「不可信来源的读回路径」该发生什么：非法项被丢弃、整体坏退回空数组、
 * 合法数据原样通过。日志被替身拦下，断言丢弃计数。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { log } from "./logger";
import { narrowLives, narrowSites } from "./invoke";

describe("narrowSites", () => {
  it("keeps only items whose key and name are non-empty strings", () => {
    const good = { key: "apple", name: "苹果", enabled: true };
    const input = [
      good,
      { key: "", name: "空 key" }, // key 为空串 → 丢弃
      { key: "x", name: "   " }, // name 全空白 → 丢弃
      { key: "noName" }, // 缺 name → 丢弃
      { name: "noKey" }, // 缺 key → 丢弃
      null, // 非对象 → 丢弃
      "string", // 非对象 → 丢弃
      42, // 非对象 → 丢弃
      { key: "banana", name: "香蕉" },
    ];
    const out = narrowSites(input);
    expect(out).toHaveLength(2);
    // 合法项原样通过：保留对象引用，不复制、不改字段。
    expect(out[0]).toBe(good);
    expect(out[1]).toEqual({ key: "banana", name: "香蕉" });
    expect(log.warn).toHaveBeenCalledWith("ipc narrow dropped sites", { dropped: 7 });
  });

  it("passes a clean array through untouched and logs nothing", () => {
    vi.mocked(log.warn).mockClear();
    const input = [{ key: "a", name: "A" }, { key: "b", name: "B" }];
    expect(narrowSites(input)).toEqual(input);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("returns an empty array when the whole value is not an array", () => {
    vi.mocked(log.warn).mockClear();
    expect(narrowSites(null)).toEqual([]);
    expect(narrowSites(undefined)).toEqual([]);
    expect(narrowSites("{}")).toEqual([]);
    expect(narrowSites({ key: "a", name: "A" })).toEqual([]);
    // 整体坏 → []，不算「丢弃项」，不发 dropped 日志。
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("returns a fresh empty array for an empty input", () => {
    expect(narrowSites([])).toEqual([]);
  });
});

describe("narrowLives", () => {
  it("keeps only items whose name and url are non-empty strings", () => {
    const good = { name: "CCTV1", url: "https://example.com/cctv1.m3u" };
    const input = [
      good,
      { name: "", url: "https://example.com/a" }, // 空 name → 丢弃
      { name: "no url" }, // 缺 url → 丢弃
      { name: "blank url", url: "  " }, // 全空白 url → 丢弃
      { url: "https://example.com/b" }, // 缺 name → 丢弃
      [], // 非对象 → 丢弃
      { name: "卫视为", url: "https://example.com/ws" },
    ];
    const out = narrowLives(input);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(good);
    expect(out[1]).toEqual({ name: "卫视为", url: "https://example.com/ws" });
    expect(log.warn).toHaveBeenCalledWith("ipc narrow dropped lives", { dropped: 5 });
  });

  it("drops url-less container sources by design (trust boundary)", () => {
    vi.mocked(log.warn).mockClear();
    const container = { name: "分组", group: "g", channels: [{ name: "c", urls: ["u"] }] };
    expect(narrowLives([container])).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith("ipc narrow dropped lives", { dropped: 1 });
  });

  it("returns an empty array when the whole value is not an array", () => {
    expect(narrowLives(null)).toEqual([]);
    expect(narrowLives(undefined)).toEqual([]);
    expect(narrowLives("nope")).toEqual([]);
  });
});
