/**
 * 播放页「手动换集 / 换线路 / 换源」的过渡桥。
 *
 * 这三种操作都会 navigate 重建播放页（路由 key 里带着地址），旧实现是点了就
 * 瞬间换一屏：画面断一下、进度条归零、加载态直接顶脸，观感很生硬。
 *
 * 现在动笔前先压一层暗幕，180ms 后再导航；新页面挂载时读到同一个标记，把
 * 暗幕继续盖着，等地址解析出来、画面能播了再淡出。中间经过 sessionStorage，
 * 因为跨路由重建后内存状态已经没了。
 */

interface PlaySwitch {
  label: string;
  at: number;
}

const KEY = "luma:playSwitch";
/** 超过这个时间的标记视为上一次遗留（比如用户中途关掉了窗口）。 */
const MAX_AGE_MS = 8000;

/**
 * 同一次页面生命周期内的直达通道：导航走的是同一个 JS 上下文，模块变量不随
 * 路由重建丢失，比 sessionStorage 更即时；sessionStorage 只负责「整页刷新」兜底。
 */
let pending: PlaySwitch | null = null;

function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** 导航前调用：记下这次切换的说明，供新页面揭幕时显示。 */
export function markPlaySwitch(label: string): void {
  pending = { label, at: Date.now() };
  const storage = store();
  if (!storage) return;
  try {
    storage.setItem(KEY, JSON.stringify(pending satisfies PlaySwitch));
  } catch {
    // 存储写不进去只是少一层过渡，不影响播放。
  }
}

/** 丢弃标记（导航失败 / 用户取消时用，避免下次进播放页莫名其妙盖一层幕）。 */
export function clearPlaySwitch(): void {
  pending = null;
  const storage = store();
  if (!storage) return;
  try {
    storage.removeItem(KEY);
  } catch {
    // 同上。
  }
}

function fresh(value: unknown): PlaySwitch | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<PlaySwitch>;
  if (typeof parsed.label !== "string" || !parsed.label.trim()) return null;
  if (typeof parsed.at !== "number" || Date.now() - parsed.at > MAX_AGE_MS) return null;
  return { label: parsed.label, at: parsed.at };
}

/**
 * 读取标记但**不消费**：React 18 StrictMode 会把 useState 的初始化函数跑两遍，
 * 「读一次就删」的写法在第二遍会拿到空值，过渡幕在开发环境直接丢。改成读与清
 * 分离，挂载后的 effect 再调用 `clearPlaySwitch`。
 */
export function peekPlaySwitch(): PlaySwitch | null {
  if (pending) return fresh(pending);
  const storage = store();
  if (!storage) return null;
  try {
    const raw = storage.getItem(KEY);
    return raw ? fresh(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
