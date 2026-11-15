import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 统一 build 号取「宿主本次启动时刻」：侧栏与设置页共用一次请求，取不到时回退
 * 前端构建时刻（浏览器里没有宿主）。见 `src/lib/appInfo.ts`。
 */

const diagnostics = vi.fn();

vi.mock("./invoke", () => ({ api: { diagnostics: (...args: unknown[]) => diagnostics(...args) } }));

async function load() {
  vi.resetModules();
  return import("./appInfo");
}

beforeEach(() => {
  diagnostics.mockReset();
});

describe("appInfo: unified build stamp", () => {
  it("caches the host start time and reuses one request", async () => {
    diagnostics.mockResolvedValue({ startedAt: "1700000000" });
    const { loadStartedAt, currentStartedAt, unifiedBuildStamp } = await load();

    expect(currentStartedAt()).toBe("");
    await expect(loadStartedAt()).resolves.toBe("1700000000");
    await expect(loadStartedAt()).resolves.toBe("1700000000");
    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(unifiedBuildStamp(currentStartedAt())).toMatch(/^\d{14}$/);
  });

  it("falls back to the frontend build stamp when the host is unreachable", async () => {
    diagnostics.mockRejectedValue(new Error("no host"));
    const { loadStartedAt, currentStartedAt, unifiedBuildStamp } = await load();

    await expect(loadStartedAt()).resolves.toBe("");
    expect(currentStartedAt()).toBe("");
    // 浏览器单跑前端时 BUILD_STAMP 也是空的（没有 __BUILD_TIME__），断言回退不抛错即可。
    expect(typeof unifiedBuildStamp(currentStartedAt())).toBe("string");
  });

  it("allows a retry after a failed load", async () => {
    diagnostics.mockRejectedValueOnce(new Error("transient")).mockResolvedValue({ startedAt: "1700000001" });
    const { loadStartedAt } = await load();

    await expect(loadStartedAt()).resolves.toBe("");
    await expect(loadStartedAt()).resolves.toBe("1700000001");
    expect(diagnostics).toHaveBeenCalledTimes(2);
  });
});
