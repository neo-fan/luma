import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS,
  clampRate,
  clampVolume,
  readPlayerPrefs,
  writePlayerPrefs,
} from "./playerPrefs";

/** 最小内存 Storage：测试不碰真实 localStorage。 */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, value),
  } as Storage;
}

describe("clampVolume / clampRate", () => {
  it("把越界值夹回可用区间", () => {
    expect(clampVolume(0)).toBe(0); // 0 = 静音，是有效偏好，不该被改写
    expect(clampVolume(2)).toBe(1);
    expect(clampVolume(0.35)).toBe(0.35);
    expect(clampRate(0.1)).toBe(0.5);
    expect(clampRate(10)).toBe(3);
    expect(clampRate(1.5)).toBe(1.5);
  });

  it("非数字退回默认值", () => {
    expect(clampVolume(Number.NaN)).toBe(DEFAULT_PREFS.volume);
    // 非有限数按设计回落默认值，而非夹到上界。
    expect(clampRate(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PREFS.rate);
  });

  it("静音（volume=0）能被记住，不被当成缺省值", () => {
    const storage = fakeStorage();
    writePlayerPrefs({ volume: 0 }, storage);
    expect(readPlayerPrefs(storage).volume).toBe(0);
  });
});

describe("readPlayerPrefs", () => {
  it("空存储返回默认值", () => {
    expect(readPlayerPrefs(fakeStorage())).toEqual(DEFAULT_PREFS);
  });

  it("容忍损坏的 JSON 与越界字段", () => {
    expect(readPlayerPrefs(fakeStorage({ "luma:player:prefs": "{oops" }))).toEqual(DEFAULT_PREFS);
    const prefs = readPlayerPrefs(
      fakeStorage({ "luma:player:prefs": JSON.stringify({ volume: 5, rate: 0.1, height: 0 }) }),
    );
    expect(prefs.volume).toBe(1);
    expect(prefs.rate).toBe(0.5);
    expect(prefs.height).toBeUndefined();
  });
});

describe("writePlayerPrefs", () => {
  it("按补丁合并并持久化", () => {
    const storage = fakeStorage();
    writePlayerPrefs({ volume: 0.4 }, storage);
    const after = writePlayerPrefs({ rate: 1.5 }, storage);
    expect(after).toEqual({ volume: 0.4, rate: 1.5 });
    expect(readPlayerPrefs(storage)).toEqual({ volume: 0.4, rate: 1.5 });
  });

  it("清晰度按整数落地，非法值被清掉", () => {
    const storage = fakeStorage();
    expect(writePlayerPrefs({ height: 1080.4 }, storage).height).toBe(1080);
    expect(writePlayerPrefs({ height: 0 }, storage).height).toBeUndefined();
  });

  it("存储不可用时只返回合并结果，不抛异常", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(() => writePlayerPrefs({ volume: 0.2 }, broken)).not.toThrow();
  });
});
