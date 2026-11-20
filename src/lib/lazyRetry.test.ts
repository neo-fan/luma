import { describe, expect, it, vi } from "vitest";
import { loadWithRetry } from "./lazyRetry";
import { log } from "./logger";

vi.mock("./logger", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

describe("loadWithRetry", () => {
  it("首次成功：只调一次，不重试、不记日志", async () => {
    const load = vi.fn().mockResolvedValue({ default: "ok" });
    const r = await loadWithRetry("LivePage", load, 0);
    expect(r).toEqual({ default: "ok" });
    expect(load).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("首次失败、重试成功：吞掉瞬时错误（Vite 重启 / 弱网 chunk 拉取失败）", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("Failed to fetch dynamically imported module"))
      .mockResolvedValueOnce({ default: "ok" });
    const r = await loadWithRetry("LivePage", load, 0);
    expect(r).toEqual({ default: "ok" });
    expect(load).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith("lazy chunk retry", expect.objectContaining({ name: "LivePage" }));
  });

  it("两次都失败：把第二次的错误抛出，交给错误边界（绝不无限重试）", async () => {
    const boom = new Error("still broken");
    const load = vi.fn().mockRejectedValue(boom);
    await expect(loadWithRetry("PlayerPage", load, 0)).rejects.toBe(boom);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
