import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 更新回执只存在本机 localStorage：这里用最小内存桩，避免测试读写真实环境。
 */
const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("updatePrefs: pending update receipt", () => {
  it("defaults to no pending update", async () => {
    const { readUpdatePrefs } = await import("./updatePrefs");
    expect(readUpdatePrefs().pendingVersion).toBe("");
  });

  it("persists the pending target version and keeps other prefs", async () => {
    const { readUpdatePrefs, writeUpdatePrefs } = await import("./updatePrefs");
    writeUpdatePrefs({ autoCheck: false, dismissedVersion: "2.0.1" });
    const next = writeUpdatePrefs({ pendingVersion: "2.0.2" });

    expect(next.pendingVersion).toBe("2.0.2");
    expect(readUpdatePrefs()).toMatchObject({
      autoCheck: false,
      dismissedVersion: "2.0.1",
      pendingVersion: "2.0.2",
    });
  });

  it("treats an old payload without pendingVersion as empty", async () => {
    store.set("luma.update.prefs", JSON.stringify({ autoCheck: true }));
    const { readUpdatePrefs } = await import("./updatePrefs");
    expect(readUpdatePrefs().pendingVersion).toBe("");
  });
});
