import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  installGlobalErrorLogging,
  isBenignMediaAbort,
  redactUrl,
} from "./logger";
import type { LogEntry } from "./logger";

function makeLogger(overrides: Partial<Parameters<typeof createLogger>[0]> = {}) {
  const batches: LogEntry[][] = [];
  const send = vi.fn(async (entries: LogEntry[]) => {
    batches.push(entries);
  });
  const logger = createLogger({ send, dev: false, flushDelayMs: 5, ...overrides });
  return { logger, send, batches };
}

describe("redactUrl", () => {
  it("drops query and fragment, keeps origin + path", () => {
    expect(redactUrl("https://cdn.test/a/index.m3u8?token=secret#t=10")).toBe(
      "https://cdn.test/a/index.m3u8",
    );
  });

  it("truncates very long urls", () => {
    const long = `https://cdn.test/${"a".repeat(300)}`;
    expect(redactUrl(long).length).toBe(161);
    expect(redactUrl(long).endsWith("…")).toBe(true);
  });
});

describe("isBenignMediaAbort", () => {
  it("只认 play() 被 pause() 打断这一类 AbortError", () => {
    const abort = new Error("The play() request was interrupted by a call to pause().");
    abort.name = "AbortError";
    expect(isBenignMediaAbort(abort)).toBe(true);
    // 名字对但内容不是 play 竞态：不能顺手吞掉，那是真问题。
    const other = new Error("signal aborted");
    other.name = "AbortError";
    expect(isBenignMediaAbort(other)).toBe(false);
    // 内容像但名字不对（被包装过的错误）也不吞。
    expect(isBenignMediaAbort(new Error("The play() request was interrupted by a call to pause()."))).toBe(false);
    expect(isBenignMediaAbort(undefined)).toBe(false);
    expect(isBenignMediaAbort("The play() request was interrupted")).toBe(false);
  });
});

describe("installGlobalErrorLogging", () => {
  // 这些用例要伪造 window，跑完必须还原，否则同文件后面的用例看到假 window。
  const globalAny = globalThis as { window?: unknown };
  let original: unknown;
  beforeEach(() => {
    original = globalAny.window;
  });
  afterEach(() => {
    globalAny.window = original;
  });

  /** 在 node 环境下造一个最小 window，抓住注册进去的处理器再手动触发。 */
  function withWindow(handlerName: string) {
    const listeners = new Map<string, (event: unknown) => void>();
    globalAny.window = {
      addEventListener: (name: string, cb: (event: unknown) => void) => listeners.set(name, cb),
    };
    const entries: Array<{ level: string; message: string }> = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (message: string) => entries.push({ level: "warn", message }),
      error: (message: string) => entries.push({ level: "error", message }),
      flush: () => Promise.resolve(),
    };
    installGlobalErrorLogging(logger as unknown as Parameters<typeof installGlobalErrorLogging>[0]);
    const fire = (event: unknown) => listeners.get(handlerName)?.(event);
    return { entries, fire };
  }

  it("play() 竞态被标成已处理并降为 warn，其它 rejection 仍按 error 上报", () => {
    const { entries, fire } = withWindow("unhandledrejection");
    let prevented = false;
    const abort = new Error("The play() request was interrupted by a call to pause().");
    abort.name = "AbortError";
    fire({ reason: abort, preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    expect(entries).toEqual([{ level: "warn", message: "media play interrupted by pause" }]);

    fire({ reason: new Error("boom"), preventDefault: () => { prevented = false; } });
    expect(entries.at(-1)).toEqual({ level: "error", message: "unhandled rejection" });
  });

  it("error 事件仍照原样上报，不做任何分类", () => {
    const { entries, fire } = withWindow("error");
    fire({ message: "Uncaught TypeError", filename: "app.js", lineno: 1, colno: 2, error: {} });
    expect(entries).toEqual([{ level: "error", message: "window error" }]);
  });
});

describe("createLogger", () => {
  it("batches queued entries into one send", async () => {
    const { logger, send, batches } = makeLogger();
    logger.info("first", { site: "s1" });
    logger.warn("second");
    await logger.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(batches[0].map((entry) => [entry.level, entry.message])).toEqual([
      ["info", "first"],
      ["warn", "second"],
    ]);
    expect(batches[0][0].context).toEqual({ site: "s1" });
  });

  it("drops debug when not in dev, keeps it in dev", async () => {
    const prod = makeLogger();
    prod.logger.debug("noise");
    await prod.logger.flush();
    expect(prod.send).not.toHaveBeenCalled();

    const dev = makeLogger({ dev: true });
    dev.logger.debug("detail");
    await dev.logger.flush();
    expect(dev.batches[0][0]).toMatchObject({ level: "debug", message: "detail" });
  });

  it("keeps the newest entries when the queue overflows and reports the loss", async () => {
    const { logger, batches } = makeLogger({ maxQueue: 2 });
    logger.info("a");
    logger.info("b");
    logger.info("c");
    logger.info("d");
    await logger.flush();

    const entries = batches.flat();
    expect(entries[0].level).toBe("warn");
    expect(entries[0].message).toContain("dropped 2 entries");
    expect(entries.slice(1).map((entry) => entry.message)).toEqual(["c", "d"]);
  });

  it("shares one in-flight flush between concurrent callers", async () => {
    const { logger, send } = makeLogger();
    logger.info("x");
    logger.info("y");
    await Promise.all([logger.flush(), logger.flush(), logger.flush()]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("truncates oversized messages before sending", async () => {
    const { logger, batches } = makeLogger();
    logger.info("中".repeat(2500));
    await logger.flush();
    const message = batches[0][0].message;
    expect(message.endsWith("…")).toBe(true);
    expect(message.length).toBe(2001);
  });

  it("keeps logging best-effort when the transport fails", async () => {
    const send = vi.fn(async () => {
      throw new Error("ipc down");
    });
    const logger = createLogger({ send, dev: false, flushDelayMs: 5 });
    logger.error("boom");
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
