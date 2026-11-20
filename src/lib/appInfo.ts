/**
 * 前后端统一的运行期信息：build 号、发布通道、最终版本。
 *
 * `tauri dev` 下前端（Vite 起 dev server）和后端（cargo 编译）的构建时刻必然不同，
 * 设置页里分「前端构建 / 后端构建」两行永远对不上；统一取宿主启动时刻后一个进程
 * 只有一个值，前端不再自报构建时间。真值在 Rust：`src-tauri/src/infra/started.rs`
 * → `Diagnostics::started_at` → 这里缓存一份给侧栏与设置页共用。
 *
 * 通道同理只认宿主（`infra/channel.rs` 从 identifier 推导）。前端不自己判断
 * 「我是不是 beta」——构建期环境变量与运行时配置各说一套是这类问题的常见源头。
 *
 * 浏览器里单跑前端（无宿主）时取不到，回退到前端构建时刻，保证不显示空白。
 */
import { api } from "./invoke";
import { BUILD_STAMP, formatBuildTime } from "./version";

export interface RuntimeInfo {
  startedAt: string;
  channel: string;
}

let cached = "";
let cachedChannel = "";
let pending: Promise<RuntimeInfo> | null = null;

/** 已拿到的启动时刻（epoch 秒字符串）；未拿到为空串，调用方据此回退。 */
export function currentStartedAt(): string {
  return cached;
}

/** 已拿到的通道（`stable` / `beta` / `dev`）；未拿到为空串。 */
export function currentChannel(): string {
  return cachedChannel;
}

/** 取一次诊断快照里的运行期信息；多个组件共用同一个请求，失败后允许下次重试。 */
export function loadRuntimeInfo(): Promise<RuntimeInfo> {
  if (cached) {
    return Promise.resolve({ startedAt: cached, channel: cachedChannel });
  }
  if (!pending) {
    pending = api
      .diagnostics()
      .then((value) => {
        cached = value.startedAt || "";
        cachedChannel = value.channel || "";
        return { startedAt: cached, channel: cachedChannel };
      })
      .catch(() => {
        pending = null;
        return { startedAt: "", channel: "" };
      });
  }
  return pending;
}

/** 只要 build 号时的薄包装（与 `loadRuntimeInfo` 共用同一次请求）。 */
export function loadStartedAt(): Promise<string> {
  return loadRuntimeInfo().then((info) => info.startedAt);
}

/** 显示用的统一 build 号：宿主启动时刻优先，浏览器兜底前端构建号。 */
export function unifiedBuildStamp(startedAt?: string | null): string {
  return formatBuildTime(startedAt) || BUILD_STAMP;
}