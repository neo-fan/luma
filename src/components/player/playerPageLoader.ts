import { loadWithRetry } from "../../lib/lazyRetry";

/**
 * `PlayerPage` 的唯一动态 import 点：路由层（PlayerHost）、详情页预热都走这里，
 * Vite 对同一 import 去重，预热过的 chunk 在真正 `lazy()` 时同步命中。
 *
 * 为什么必须拆出来：这段 import 决定的是播放器内核（hls.js 582 KiB +
 * artplayer 138 KiB + usePlayerEngine 82 KiB + PlayerPage 30 KiB，约 835 KiB /
 * gzip 257 KiB）落在哪个 chunk 里。拆成独立模块后，预热方只依赖这个加载器，
 * 不会把 PlayerHost 组件一起拖进自己的 chunk。
 */
export const loadPlayerPage = () =>
  loadWithRetry("PlayerPage", () => import("../../pages/PlayerPage"));
