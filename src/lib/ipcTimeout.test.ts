/**
 * IPC 单点超时：任何 fast command 的 promise 都必须有界，慢命令不套短超时。
 *
 * 背景：同步 command 跑 Tauri 主线程，被 spider_invoke 等长任务占住时前端 await
 * 永久悬挂，调用方写的 `busy + try/finally` 就永久锁死（历史删除按钮实测）。
 * 这里直接测可注入 invokeFn 的纯逻辑，不需要 Tauri 运行时。
 */
import { describe, expect, it, vi } from "vitest";
import { callWithTimeout, hasFastIpcTimeout } from "./invoke";

describe("hasFastIpcTimeout", () => {
  it("gives short timeout to in-memory / sqlite commands", () => {
    expect(hasFastIpcTimeout("history_remove")).toBe(true);
    expect(hasFastIpcTimeout("config_activate")).toBe(true);
    expect(hasFastIpcTimeout("log_write")).toBe(true);
  });

  it("exempts commands that already have their own business timeout", () => {
    for (const cmd of [
      "spider_invoke",
      "http_fetch",
      "site_health",
      "douban_request",
      "live_parse",
      "config_refresh",
      "update_download",
      "diagnostics",
      "export_report",
      "storage_clear",
    ]) {
      expect(hasFastIpcTimeout(cmd), cmd).toBe(false);
    }
  });
});

describe("callWithTimeout", () => {
  it("returns the invoke result and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      const invokeFn = vi.fn().mockResolvedValue("ok");
      const promise = callWithTimeout(invokeFn, "history_remove", {}, 1000);
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe("ok");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with IPC_TIMEOUT when the host never answers", async () => {
    vi.useFakeTimers();
    try {
      const invokeFn = vi.fn().mockImplementation(() => new Promise(() => undefined));
      const promise = callWithTimeout(invokeFn, "history_remove", {}, 1000);
      const assertion = expect(promise).rejects.toMatchObject({
        code: "IPC_TIMEOUT",
        message: expect.stringContaining("history_remove"),
      });
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never times out a slow command even if it takes longer", async () => {
    vi.useFakeTimers();
    try {
      const invokeFn = vi.fn().mockImplementation(() => new Promise(() => undefined));
      const promise = callWithTimeout(invokeFn, "spider_invoke", {}, 1000);
      await vi.advanceTimersByTimeAsync(5000);
      // 没有超时 reject：promise 仍在 pending（慢命令自带业务超时，由后端兑现）。
      let settled = false;
      void promise.then(
        () => (settled = true),
        () => (settled = true),
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
