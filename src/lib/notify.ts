import type { CSSProperties } from "react";
import { toast } from "sonner";
import { noticeTtl, type NoticeTone } from "./notice";

/**
 * 全局提示通道（sonner）的唯一入口。
 *
 * 页面不要再直接 `import { toast } from "sonner"`：直接调用会绕开时长表与去重，
 * 又退回「每处各写一个 duration」的老路。这里统一：
 *  - 时长来自 `NOTICE_TTL`（info/success 4s、warn 8s、error 常驻）；
 *  - 同一条文案 1.2s 内只弹一次（重连/重试链路会连续抛同一个错）；
 *  - 给 toast 挂 `--notice-life` 变量，进度线与页内 ErrorBar 共用同一 keyframes。
 *
 * 分工：**后台事件**走这里（已自动换线、订阅已更新、已加入收藏）；
 * **阻断当前任务、需要用户决策**的错误留在页内 `ErrorBar`。
 */
const DEDUPE_MS = 1_200;
const lastShown = new Map<string, number>();

interface NotifyOptions {
  /** 需要更长/更短时显式覆盖；不传则按 tone 取表值。 */
  ttlMs?: number;
  description?: string;
}

function push(
  tone: NoticeTone,
  text: string,
  options: NotifyOptions = {},
): void {
  const ttl = options.ttlMs ?? noticeTtl(tone);
  const key = `${tone}:${text}`;
  const now = Date.now();
  const seen = lastShown.get(key);
  if (seen !== undefined && now - seen < DEDUPE_MS) {
    return;
  }
  lastShown.set(key, now);

  const common: {
    duration: number;
    className: string;
    description?: string;
    closeButton: boolean;
    style: CSSProperties;
  } = {
    // sonner: Infinity = 不自动关闭
    duration: ttl > 0 ? ttl : Infinity,
    // 会自动消失的告知类不给 ×；常驻错误必须留一个手动关闭入口。
    closeButton: ttl === 0,
    className: "notice-toast",
    description: options.description,
    style: {
      // 进度线时长；常驻提示给 0ms，进度线瞬间走完即不可见（不假装它会消失）
      "--notice-life": `${ttl}ms`,
    } as CSSProperties,
  };

  if (tone === "success") {
    toast.success(text, common);
  } else if (tone === "error") {
    toast.error(text, common);
  } else if (tone === "warn") {
    toast.warning(text, common);
  } else {
    toast.info(text, common);
  }
}

export const notify = {
  info: (text: string, options?: NotifyOptions) => push("info", text, options),
  success: (text: string, options?: NotifyOptions) =>
    push("success", text, options),
  warn: (text: string, options?: NotifyOptions) => push("warn", text, options),
  error: (text: string, options?: NotifyOptions) =>
    push("error", text, options),
};
