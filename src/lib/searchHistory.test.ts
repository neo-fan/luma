import { describe, expect, it } from "vitest";
import {
  MAX_SEARCH_HISTORY,
  SEARCH_HISTORY_KEY,
  clearSearchHistory,
  pushSearchHistory,
  readSearchHistory,
  removeSearchHistory,
  sanitizeSearchHistory,
} from "./searchHistory";

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

/** 存储被禁用时所有 API 都要能抛异常而不拖垮页面。 */
function brokenStorage(): Storage {
  return {
    get length() {
      throw new Error("blocked");
    },
    clear: () => {
      throw new Error("blocked");
    },
    getItem: () => {
      throw new Error("blocked");
    },
    key: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  } as unknown as Storage;
}

describe("pushSearchHistory", () => {
  it("只记实际提交的词，空词与纯空格不落盘", () => {
    const store = fakeStorage();
    expect(pushSearchHistory("   ", store)).toEqual([]);
    expect(pushSearchHistory("", store)).toEqual([]);
    expect(store.getItem(SEARCH_HISTORY_KEY)).toBeNull();
  });

  it("最新在前，且写入后可以读回", () => {
    const store = fakeStorage();
    pushSearchHistory("庆余年", store);
    expect(pushSearchHistory("走马上任", store)).toEqual(["走马上任", "庆余年"]);
    expect(readSearchHistory(store)).toEqual(["走马上任", "庆余年"]);
  });

  it("重复词提到最前而不重复占位，英文大小写视为同一个词", () => {
    const store = fakeStorage();
    pushSearchHistory("Avatar", store);
    pushSearchHistory("走马上任", store);
    expect(pushSearchHistory("AVATAR", store)).toEqual(["AVATAR", "走马上任"]);
    expect(readSearchHistory(store)).toHaveLength(2);
  });

  it(`最多 ${MAX_SEARCH_HISTORY} 条，超出时淘汰最旧的一条`, () => {
    const store = fakeStorage();
    for (let i = 1; i <= MAX_SEARCH_HISTORY; i += 1) {
      pushSearchHistory(`词${i}`, store);
    }
    expect(readSearchHistory(store)[0]).toBe(`词${MAX_SEARCH_HISTORY}`);
    const next = pushSearchHistory("新词", store);
    expect(next).toHaveLength(MAX_SEARCH_HISTORY);
    expect(next[0]).toBe("新词");
    expect(next).not.toContain("词1");
    expect(next[next.length - 1]).toBe("词2");
  });

  it("trim 并截断超长输入", () => {
    const store = fakeStorage();
    expect(pushSearchHistory("  嫁金钗  ", store)).toEqual(["嫁金钗"]);
    const long = "片".repeat(120);
    expect(pushSearchHistory(long, store)[0]).toHaveLength(60);
  });
});

describe("sanitizeSearchHistory / readSearchHistory", () => {
  it("清洗非数组、非字符串、空词、重复词并截取上限", () => {
    expect(sanitizeSearchHistory(null)).toEqual([]);
    expect(sanitizeSearchHistory({ list: ["a"] })).toEqual([]);
    expect(sanitizeSearchHistory(["a", 1, null, "  ", "a", "A", "b"])).toEqual(["a", "b"]);
    const oversized = sanitizeSearchHistory(Array.from({ length: 20 }, (_, i) => `词${i}`));
    expect(oversized).toHaveLength(MAX_SEARCH_HISTORY);
    // 首位是最新：超量时保留前 10 条，丢掉尾部更旧的。
    expect(oversized[0]).toBe("词0");
    expect(oversized[MAX_SEARCH_HISTORY - 1]).toBe("词9");
  });

  it("损坏的 JSON 降级为空列表", () => {
    expect(readSearchHistory(fakeStorage({ [SEARCH_HISTORY_KEY]: "{oops" }))).toEqual([]);
    expect(readSearchHistory(fakeStorage())).toEqual([]);
  });

  it("读到的旧数据会被顺手清洗（含超长与重复）", () => {
    const store = fakeStorage({
      [SEARCH_HISTORY_KEY]: JSON.stringify(["旧词", "旧词", "x".repeat(100), 42]),
    });
    expect(readSearchHistory(store)).toEqual(["旧词", "x".repeat(60)]);
  });
});

describe("removeSearchHistory / clearSearchHistory", () => {
  it("单条删除大小写不敏感，清空后落盘为空数组", () => {
    const store = fakeStorage();
    pushSearchHistory("Avatar", store);
    pushSearchHistory("庆余年", store);
    expect(removeSearchHistory("avatar", store)).toEqual(["庆余年"]);
    expect(clearSearchHistory(store)).toEqual([]);
    expect(store.getItem(SEARCH_HISTORY_KEY)).toBe("[]");
  });
});

describe("存储不可用时", () => {
  it("读写都不抛异常，内存态仍可返回", () => {
    expect(readSearchHistory(brokenStorage())).toEqual([]);
    expect(pushSearchHistory("庆余年", brokenStorage())).toEqual(["庆余年"]);
    expect(clearSearchHistory(brokenStorage())).toEqual([]);
  });
});
