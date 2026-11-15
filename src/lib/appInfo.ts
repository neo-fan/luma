/**
 * 前后端统一的 build 号：宿主进程**本次的启动时刻**。
 *
 * `tauri dev` 下前端（Vite 起 dev server）和后端（cargo 编译）的构建时刻必然不同，
 * 设置页里分「前端构建 / 后端构建」两行永远对不上；统一取宿主启动时刻后一个进程
 * 只有一个值，前端不再自报构建时间。真值在 Rust：`src-tauri/src/infra/started.rs`
 * → `Diagnostics::started_at` → 这里缓存一份给侧栏与设置页共用。
 *
 * 浏览器里单跑前端（无宿主）时取不到，回退到前端构建时刻，保证不显示空白。
 */
import { api } from "./invoke";
import { BUILD_STAMP, formatBuildTime } from "./version";

let cached = "";
let pending: Promise<string> | null = null;

/** 已拿到的启动时刻（epoch 秒字符串）；未拿到为空串，调用方据此回退。 */
export function currentStartedAt(): string {
  return cached;
}

/** 取一次启动时刻；多个组件共用同一个请求，失败后允许下次重试。 */
export function loadStartedAt(): Promise<string> {
  if (cached) {
    return Promise.resolve(cached);
  }
  if (!pending) {
    pending = api
      .diagnostics()
      .then((value) => {
        cached = value.startedAt || "";
        return cached;
      })
      .catch(() => {
        pending = null;
        return "";
      });
  }
  return pending;
}

/** 显示用的统一 build 号：宿主启动时刻优先，浏览器兜底前端构建号。 */
export function unifiedBuildStamp(startedAt?: string | null): string {
  return formatBuildTime(startedAt) || BUILD_STAMP;
}
