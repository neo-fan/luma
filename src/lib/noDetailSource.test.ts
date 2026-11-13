import { describe, expect, it } from "vitest";
import { NO_DETAIL_KEY, createNoDetailStore } from "./noDetailSource";

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

describe("noDetailSource", () => {
  it("首次标记返回 true，之后 has 命中且不重复标记", () => {
    const store = createNoDetailStore({ storage: fakeStorage() });
    expect(store.has("py_douban")).toBe(false);
    expect(store.note("py_douban", "37100984")).toBe(true);
    expect(store.has("py_douban")).toBe(true);
    expect(store.note("py_douban", "37806882")).toBe(false);
  });

  it("缺 siteKey 或 vodId 时不记账", () => {
    const store = createNoDetailStore({ storage: fakeStorage() });
    expect(store.note("", "1")).toBe(false);
    expect(store.note("py_douban", "")).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("标记持久化，另一个实例能读回", () => {
    const storage = fakeStorage();
    createNoDetailStore({ storage }).note("py_douban", "1");
    const again = createNoDetailStore({ storage });
    expect(again.has("py_douban")).toBe(true);
  });

  it("forget 清掉单个源并写回存储", () => {
    const storage = fakeStorage();
    const store = createNoDetailStore({ storage });
    store.note("py_douban", "1");
    store.note("other", "2");
    store.forget("py_douban");
    expect(store.has("py_douban")).toBe(false);
    expect(createNoDetailStore({ storage }).has("other")).toBe(true);
  });

  it("clear 清空内存与存储", () => {
    const storage = fakeStorage();
    const store = createNoDetailStore({ storage });
    store.note("py_douban", "1");
    store.clear();
    expect(store.list()).toEqual([]);
    expect(storage.getItem(NO_DETAIL_KEY)).toBeNull();
  });

  it("最多保留 60 个，超出丢最早的", () => {
    const store = createNoDetailStore({ storage: fakeStorage() });
    for (let i = 0; i < 65; i += 1) {
      store.note(`site_${i}`, String(i));
    }
    const list = store.list();
    expect(list).toHaveLength(60);
    expect(list).not.toContain("site_0");
    expect(list).toContain("site_64");
  });

  it("存储里是坏数据时降级为空，不影响后续写入", () => {
    const storage = fakeStorage({ [NO_DETAIL_KEY]: "{not json" });
    const store = createNoDetailStore({ storage });
    expect(store.list()).toEqual([]);
    expect(store.note("py_douban", "1")).toBe(true);
  });

  it("存储不可用（隐私模式）也能在内存里工作", () => {
    const store = createNoDetailStore({ storage: null });
    expect(store.note("py_douban", "1")).toBe(true);
    expect(store.has("py_douban")).toBe(true);
  });

  it("同一 scope 重复调用不清，换 scope 才清空", () => {
    const storage = fakeStorage();
    const store = createNoDetailStore({ storage });
    store.setScope("cfg1");
    store.note("py_douban", "1");
    store.setScope("cfg1");
    expect(store.has("py_douban")).toBe(true);
    store.setScope("cfg2");
    expect(store.list()).toEqual([]);
  });

  it("重启后读到同一 scope，记忆不丢", () => {
    const storage = fakeStorage();
    const first = createNoDetailStore({ storage });
    first.setScope("cfg1");
    first.note("py_douban", "1");
    const again = createNoDetailStore({ storage });
    again.setScope("cfg1");
    expect(again.has("py_douban")).toBe(true);
  });
});
