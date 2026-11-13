/**
 * 全局唯一播放实例守卫。
 *
 * 实测（CDP `Runtime.queryObjects`）发现：连续切集后堆里会留下多个已 detach、
 * 却仍 `paused === false` 的 `<video>`，每个都挂着自己的 blob: MSE 源在出声，
 * 于是用户听到「两个声音」。React 的 effect cleanup 正常时不会这样，但 Vite HMR
 * 会重新求值模块、Fast Refresh 重挂组件，旧实例注册的 cleanup 随之丢失——
 * 模块级变量也会一起被重置，所以它必须挂在 `globalThis` 上跨 HMR 存活。
 *
 * 约定：创建 ArtPlayer **之前**先 `stopActivePlayer()` 硬停上一个实例；创建
 * 完成后 `registerPlayer(hardStop)` 登记新实例的硬停函数；cleanup 里注销。
 * 硬停函数必须幂等（React cleanup 与下次 claim 都可能调到它）。
 */

type HardStop = () => void;

interface Registry {
  active: { id: number; stop: HardStop } | null;
  seq: number;
}

/** 挂 globalThis 才能在 Vite HMR 重求值模块后仍找到「上一个」实例。 */
const KEY = "__luma_active_player_v1__";

function registry(): Registry {
  const scope = globalThis as typeof globalThis & { [KEY]?: Registry };
  if (!scope[KEY]) {
    scope[KEY] = { active: null, seq: 0 };
  }
  return scope[KEY];
}

/**
 * 创建播放器前调用：停掉仍活跃的旧实例，并清掉 DOM 里不属于当前容器的
 * `<video>`。已 detach 的游离实例只能靠注册表里的硬停函数收回。
 */
export function stopActivePlayer(container?: HTMLElement | null): void {
  const reg = registry();
  const previous = reg.active;
  reg.active = null;
  if (previous) {
    try {
      previous.stop();
    } catch {
      // 旧实例可能已被 ArtPlayer 自己销毁，硬停失败不应阻断新实例创建。
    }
  }
  // DOM 内残留（例如 HMR 后模板没被摘干净）也一并静音停流。
  for (const video of document.querySelectorAll("video")) {
    if (container?.contains(video)) {
      continue;
    }
    try {
      video.pause();
      video.removeAttribute("src");
      video.load();
    } catch {
      // 已 detach 的元素可能抛 InvalidStateError，忽略。
    }
  }
}

/** 实例创建完成后登记；返回注销函数（只注销自己，不误伤后来者）。 */
export function registerPlayer(stop: HardStop): () => void {
  const reg = registry();
  const id = ++reg.seq;
  reg.active = { id, stop };
  return () => {
    if (reg.active?.id === id) {
      reg.active = null;
    }
  };
}
