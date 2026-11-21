/**
 * 线路健康记录：跳过「公认解不开」的线路，优先最近成功过的线路。
 *
 * 场景：布布追剧的 `zijianm3u8` 是网盘 token 线路，源侧今天解不开，每次点它
 * 都要先干等一次 playerContent（8 秒）再换线，自动接下一集还会重来。这里记
 * 一笔，30 分钟内直接跳过；成功一次立刻恢复信任。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BAD_TTL_MS,
  LINE_RANK_BAD,
  LINE_RANK_GOOD,
  LINE_RANK_UNKNOWN,
  isLineBad,
  lineRank,
  markLineBad,
  markLineGood,
  resetLineHealth,
} from "./lineHealth";
import { LINE_HEALTH_KEY } from "./storageKeys";

/** 最小 localStorage 桩：lineHealth 每次调用都读全局，桩生效。 */
function installStorage(): void {
  const map = new Map<string, string>();
  const stub = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage = stub as unknown as Storage;
}

beforeEach(() => {
  installStorage();
  resetLineHealth();
});

afterEach(() => {
  delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
});

describe("lineHealth", () => {
  it("坏线路在有效期内被跳过，过期后重新给机会", () => {
    const now = 1_000_000;
    markLineBad("py_bubuzhuiju", "zijianm3u8", now);
    expect(isLineBad("py_bubuzhuiju", "zijianm3u8", now + 1000)).toBe(true);
    expect(isLineBad("py_bubuzhuiju", "zijianm3u8", now + BAD_TTL_MS + 1)).toBe(false);
  });

  it("不采信没有成因的旧坏标记（旧版本把调用异常也记成坏线路）", () => {
    const now = 1_000_000;
    // 旧格式只有 `bad` 时间戳。那些记录来自「playerContent 抛异常」的误判，
    // 升级后必须一次性失效，否则用户还要再被骗 30 分钟。
    localStorage.setItem(
      LINE_HEALTH_KEY,
      JSON.stringify({ "py_bubuzhuiju\u0001BBA": { bad: now } }),
    );
    expect(isLineBad("py_bubuzhuiju", "BBA", now + 1000)).toBe(false);
    expect(lineRank("py_bubuzhuiju", "BBA", now + 1000)).toBe(LINE_RANK_UNKNOWN);
  });

  it("成功一次就恢复信任（不会被一次超时永久判死）", () => {
    const now = 1_000_000;
    markLineBad("s", "line", now);
    markLineGood("s", "line", now + 2000);
    expect(isLineBad("s", "line", now + 3000)).toBe(false);
    expect(lineRank("s", "line", now + 3000)).toBe(LINE_RANK_GOOD);
  });

  it("缺省线路是 unknown，坏线路排最后、好线路排最前", () => {
    const now = 1_000_000;
    markLineGood("s", "good", now);
    markLineBad("s", "bad", now);
    expect(lineRank("s", "good", now)).toBe(LINE_RANK_GOOD);
    expect(lineRank("s", "unknown", now)).toBe(LINE_RANK_UNKNOWN);
    expect(lineRank("s", "bad", now)).toBe(LINE_RANK_BAD);
  });

  it("站点之间互不影响", () => {
    const now = 1_000_000;
    markLineBad("siteA", "PAN1", now);
    expect(isLineBad("siteA", "PAN1", now + 1000)).toBe(true);
    expect(isLineBad("siteB", "PAN1", now + 1000)).toBe(false);
  });

  it("localStorage 不可用时静默降级（不抛错）", () => {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    expect(() => markLineBad("s", "l")).not.toThrow();
    expect(isLineBad("s", "l")).toBe(false);
    expect(lineRank("s", "l")).toBe(LINE_RANK_UNKNOWN);
  });
});
