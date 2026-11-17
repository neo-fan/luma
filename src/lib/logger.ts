/**
 * 前端日志：批量写入 Rust 侧 `log_write`，最终落到 `<data>/logs/luma-*.log`。
 *
 * 为什么不在前端直接写文件：WebView2 没有任意路径写权限，日志目录、滚动、
 * 脱敏都应只有一份实现。这里只做「收集 + 合并 + 尽力发送」，失败完全静默
 * ——日志不能反过来影响播放。
 *
 * 约束：
 * - 300ms / 20 条合并成一次 IPC，避免聚合搜索时几十条日志打满 bridge；
 * - 队列上限 200，溢出丢最旧并补一条 warn，防止离线时无限增长；
 * - `debug` 只在 dev 发送，试运行默认只留 info / warn / error；
 * - 不记录播放直链、完整 URL（`redactUrl` 只留 origin + path）。
 */
import { invoke } from "@tauri-apps/api/core";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  /** 立即发送队列；测试与 `beforeunload` 使用。 */
  flush(): Promise<void>;
}

export interface LoggerOptions {
  send: (entries: LogEntry[]) => Promise<void>;
  dev?: boolean;
  now?: () => number;
  flushDelayMs?: number;
  batchSize?: number;
  maxQueue?: number;
}

const MAX_MESSAGE = 2000;
const MAX_CONTEXT_TEXT = 1200;

/** URL 只留 origin + path：query 里常有 token / 签名，不能落盘。 */
export function redactUrl(raw: string): string {
  const text = String(raw ?? "").trim();
  const head = text.split(/[?#]/)[0] ?? text;
  return head.length > 160 ? `${head.slice(0, 160)}…` : head;
}

function clip(value: unknown, max = MAX_CONTEXT_TEXT): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function createLogger(options: LoggerOptions): Logger {
  const {
    send,
    dev = false,
    flushDelayMs = 300,
    batchSize = 20,
    maxQueue = 200,
  } = options;

  let queue: LogEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing: Promise<void> | null = null;
  let dropped = 0;

  const schedule = () => {
    if (timer !== null) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushDelayMs);
  };

  const flush = (): Promise<void> => {
    if (flushing) {
      return flushing;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    flushing = (async () => {
      if (dropped > 0) {
        queue.unshift({
          level: "warn",
          message: `log queue overflow, dropped ${dropped} entries`,
        });
        dropped = 0;
      }
      while (queue.length > 0) {
        const batch = queue.splice(0, batchSize);
        try {
          await send(batch);
        } catch {
          // 日志通道失败不影响应用；丢弃这一批，避免死循环重试。
        }
      }
    })().finally(() => {
      flushing = null;
      if (queue.length > 0) {
        schedule();
      }
    });
    return flushing;
  };

  const enqueue = (level: LogLevel, message: string, context?: Record<string, unknown>) => {
    if (level === "debug" && !dev) {
      return;
    }
    if (dev || level === "error") {
      // 试运行时错误仍进控制台（WebView2 的 devtools 可看），其它级别只落盘。
      const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
      sink(`[luma:${level}] ${message}`, context ?? "");
    }
    queue.push({
      level,
      message: clip(message, MAX_MESSAGE),
      context,
    });
    while (queue.length > maxQueue) {
      queue.shift();
      dropped += 1;
    }
    schedule();
  };

  return {
    debug: (message, context) => enqueue("debug", message, context),
    info: (message, context) => enqueue("info", message, context),
    warn: (message, context) => enqueue("warn", message, context),
    error: (message, context) => enqueue("error", message, context),
    flush,
  };
}

function defaultSend(entries: LogEntry[]): Promise<void> {
  return invoke("log_write", { entries }).then(() => undefined);
}

/** 应用单例：所有页面共用同一个队列。 */
export const log: Logger = createLogger({
  send: defaultSend,
  dev: import.meta.env.DEV,
});

/**
 * 是否为「play() 被 pause() 打断」这一类规范内竞态。
 *
 * ArtPlayer 内部自己会调 `video.play()`；若在 promise resolve 之前发生 `pause()`，
 * HTML 规范规定该 promise 以 `AbortError` 拒绝。应用自己的 6 处 `play()` 全部已
 * `catch`，漏网的正是库内部那一次——它不是缺陷，也不该被当成缺陷上报。
 *
 * 必须识别它（而不是只降日志级别）：未处理的 rejection 会被浏览器上报成
 * `Runtime.exceptionThrown`，CDP 探针因此长期红，错误日志也会被这类噪声占满。
 * 只认 name 与 message 同时命中的，其它 rejection 一律照旧上报。
 */
export function isBenignMediaAbort(reason: unknown): boolean {
  const error = reason as { name?: string; message?: string } | undefined;
  if (error?.name !== "AbortError") {
    return false;
  }
  return /play\(\)\s+request was interrupted/i.test(String(error.message ?? ""));
}

/**
 * 兜底捕获未处理异常。React 的 error boundary 只覆盖渲染树，异步回调、
 * Promise rejection 与模块初始化异常仍会打到这里。
 */
export function installGlobalErrorLogging(logger: Logger = log): void {
  if (typeof window === "undefined") {
    return;
  }
  window.addEventListener("error", (event) => {
    const error = event.error as { stack?: string } | undefined;
    logger.error("window error", {
      message: clip(event.message, 600),
      source: clip(event.filename, 200),
      line: event.lineno,
      column: event.colno,
      stack: clip(error?.stack, 1500),
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as { message?: string; stack?: string } | undefined;
    if (isBenignMediaAbort(event.reason)) {
      // 标成已处理，浏览器才不会再报 Runtime.exceptionThrown；仍留一条 warn，
      // 排查「点了没声音」时它是线索（debug 在 release 会被丢掉，所以不用 debug）。
      event.preventDefault();
      logger.warn("media play interrupted by pause", {
        reason: clip(reason?.message ?? "", 200),
      });
      return;
    }
    logger.error("unhandled rejection", {
      reason: clip(reason?.message ?? String(event.reason ?? ""), 1200),
      stack: clip(reason?.stack, 1500),
    });
  });
  // 关窗前尽量把队列发出去；异步 IPC 不保证一定完成，但绝大多数能送到。
  window.addEventListener("beforeunload", () => {
    void logger.flush();
  });
}
