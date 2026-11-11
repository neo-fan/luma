/**
 * 复制文本到系统剪贴板。
 *
 * WebView2 里 navigator.clipboard 通常可用，但在非安全上下文 / 权限被拒时会
 * 失败，所以保留 execCommand 兜底。核心逻辑抽成「可注入 writer」的纯函数，
 * 这样在 node 环境（无 DOM / 无 navigator）也能直接单测，不必造假 window。
 */

export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

/** ok = 现代 API 成功；fallback = 走了 execCommand；failed = 两条路都不通。 */
export type CopyResult = "ok" | "fallback" | "failed";

function writerOf(injected?: ClipboardWriter): ClipboardWriter | null {
  if (injected) {
    return injected;
  }
  try {
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.clipboard?.writeText === "function"
    ) {
      return navigator.clipboard;
    }
  } catch {
    // 某些宿主读取 navigator.clipboard 会直接抛，视为不可用。
  }
  return null;
}

/** 老式兜底：临时 textarea + execCommand，Chromium / WebView2 仍支持。 */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }
  // 有些 WebView 暴露了 execCommand 但对 copy 返回 false，下面按返回值判定。
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/**
 * 复制失败绝不抛异常：错误提示本身不该因为「复制错误」再炸一次。
 * 返回值让调用方决定给「已复制」还是「复制失败」的即时反馈。
 */
export async function copyText(text: string, injected?: ClipboardWriter): Promise<CopyResult> {
  const writer = writerOf(injected);
  if (writer) {
    try {
      await writer.writeText(text);
      return "ok";
    } catch {
      // 权限被拒等，落到 execCommand 兜底。
    }
  }
  return legacyCopy(text) ? "fallback" : "failed";
}
