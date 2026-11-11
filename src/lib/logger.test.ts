import { describe, expect, it, vi } from "vitest";
import { createLogger, redactUrl } from "./logger";
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
