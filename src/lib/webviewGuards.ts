/**
 * 把 WebView2 收回成「应用窗口」。
 *
 * 桌面应用不该有浏览器的默认脾气：右键菜单弹出「重新加载 / 检查」、F5 刷新、
 * Ctrl+F 找页面内容、把文件拖进窗口就跳走 —— 这些都会把用户从「用一个播放器」
 * 的语境里拽出去。这里统一在 window 上拦截，Ctrl+R 是唯一保留的刷新入口
 * （宿主默认行为，不拦）。
 *
 * 只挡浏览器级行为，不碰应用自己的快捷键：Ctrl+K 命令面板、Esc 关闭弹层、
 * 输入框里的 Ctrl+C/V/A 都由各自的组件处理。
 */

/** 有修饰键（Ctrl / Cmd）时要吞掉的字母键：打印、查看源码、保存、查找…… */
const BLOCKED_CTRL_LETTERS = new Set([
  "d", // 添加收藏（WebView2 无书签，但避免与未来快捷键冲突）
  "f", // 页内查找条
  "g", // 查找下一个
  "h", // 替换
  "j", // 下载
  "l", // 地址栏
  "n", // 新窗口
  "o", // 打开文件
  "p", // 打印
  "s", // 保存页面
  "t", // 新标签
  "u", // 查看源码
  "w", // 关窗口（窗口只有一个，交给标题栏按钮）
]);

/** 缩放：Ctrl +/-/0 与 Ctrl+滚轮。 */
const ZOOM_KEYS = new Set(["+", "-", "=", "0"]);

function isDev(): boolean {
  return import.meta.env.DEV;
}

function isBlocked(event: KeyboardEvent): boolean {
  const key = event.key;
  const lower = key.toLowerCase();
  const ctrl = event.ctrlKey || event.metaKey;

  if (ctrl) {
    if (BLOCKED_CTRL_LETTERS.has(lower)) {
      return true;
    }
    if (ZOOM_KEYS.has(key)) {
      return true;
    }
    // 开发者工具（Ctrl+Shift+I / J / C）：只在 release 里挡，dev 要能用。
    if (event.shiftKey && (lower === "i" || lower === "j" || lower === "c") && !isDev()) {
      return true;
    }
    // Ctrl+R / Ctrl+Shift+R 是保留的强制刷新入口，这里刻意不拦。
    return false;
  }

  switch (key) {
    case "F5": // 刷新
    case "F3": // 页内查找
    case "F7": // 插入符浏览
      return true;
    case "F12":
      return !isDev();
    case "ArrowLeft":
    case "ArrowRight":
      // 后退 / 前进：桌面应用没有「上一页」。
      return event.altKey;
    default:
      return false;
  }
}

/** 在 window 上装一次；重复调用是幂等的（StrictMode / HMR 都安全）。 */
export function installWebviewGuards(): () => void {
  const onContextMenu = (event: MouseEvent) => {
    // 输入框也不弹：桌面端右键菜单入口是应用自己的 UI，不是 WebView 的。
    event.preventDefault();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!isBlocked(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey) {
      event.preventDefault();
    }
  };

  const onDragOver = (event: DragEvent) => {
    event.preventDefault();
  };

  const onDrop = (event: DragEvent) => {
    // 拖进来的文件不当作「打开」，也就不会把当前页面顶掉。
    event.preventDefault();
  };

  const onAuxClick = (event: MouseEvent) => {
    // 中键：既不开新窗口，也不触发自动滚动。
    if (event.button === 1) {
      event.preventDefault();
    }
  };

  window.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("drop", onDrop);
  window.addEventListener("auxclick", onAuxClick);

  return () => {
    window.removeEventListener("contextmenu", onContextMenu);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("drop", onDrop);
    window.removeEventListener("auxclick", onAuxClick);
  };
}
