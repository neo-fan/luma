import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPlaySwitch, markPlaySwitch, peekPlaySwitch } from "../../src/lib/playSwitch";

/** 内存版 sessionStorage：测试跑在 node 环境，没有真 Storage。 */
class MemoryStorage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as unknown as { window: { sessionStorage: Storage } }).window = {
    sessionStorage: storage as unknown as Storage,
  };
  clearPlaySwitch();
});

afterEach(() => {
  clearPlaySwitch();
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("playSwitch", () => {
  it("reads the label without consuming it", () => {
    markPlaySwitch("正在切换到「B 站」…");
    expect(peekPlaySwitch()?.label).toBe("正在切换到「B 站」…");
    // StrictMode 会把初始化函数跑两遍，第二遍必须还能读到。
    expect(peekPlaySwitch()?.label).toBe("正在切换到「B 站」…");
  });

  it("stops reporting after clear", () => {
    markPlaySwitch("正在切换到「第 3 集」…");
    clearPlaySwitch();
    expect(peekPlaySwitch()).toBeNull();
  });

  it("ignores stale labels", () => {
    storage.setItem("luma:playSwitch", JSON.stringify({ label: "旧的", at: Date.now() - 9000 }));
    expect(peekPlaySwitch()).toBeNull();
  });

  it("ignores blank or malformed labels", () => {
    storage.setItem("luma:playSwitch", JSON.stringify({ label: "  ", at: Date.now() }));
    expect(peekPlaySwitch()).toBeNull();
    storage.setItem("luma:playSwitch", "{not json");
    expect(peekPlaySwitch()).toBeNull();
  });
});
