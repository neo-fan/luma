import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import packageJson from "./package.json";

// 版本号唯一来源：package.json。Cargo.toml / tauri.conf.json 手工保持同步，
// 前端通过 define 注入，避免侧栏 / 诊断页 / 日志里出现三个不同版本。
const APP_VERSION = packageJson.version;

// 构建号：取最近一次提交的 short hash 与提交时间，与后端 build.rs 用完全相同
// 的方式注入，双击 exe 也能一眼比对前后端是否同源同构建（无 .git 时回退 unknown）。
function gitBuildInfo(): { hash: string; time: string } {
  try {
    const out = execSync(
      "git log -1 --format=%h|%cd --date=format:%Y-%m-%dT%H:%M:%S%z",
      { encoding: "utf-8" },
    ).trim();
    const [hash, time] = out.split("|");
    return { hash: hash || "unknown", time: time || "unknown" };
  } catch {
    return { hash: "unknown", time: "unknown" };
  }
}
const BUILD = gitBuildInfo();

// Tauri 需要固定端口；strictPort 避免端口漂移后 devUrl 对不上。
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __BUILD_HASH__: JSON.stringify(BUILD.hash),
    __BUILD_TIME__: JSON.stringify(BUILD.time),
  },
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "chrome110",
    sourcemap: false,
    // hls.js 单块约 595 kB 是第三方解码库的实际体积，且已隔离到播放页按需
    // 加载；抬高阈值避免把「刻意拆出的大 vendor 块」误报成首屏问题。
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // 播放器内核只在 PlayerPage 里被动态 import；单独成块后可以并行下载，
        // 且升级播放器时不会让业务代码的缓存失效。别把 react 也塞进 manualChunks，
        // 否则首屏会连带预加载这些大块。
        manualChunks(id) {
          const path = id.replace(/\\/g, "/");
          if (path.includes("/node_modules/hls.js/")) return "hls";
          if (path.includes("/node_modules/mpegts.js/")) return "mpegts";
          if (path.includes("/node_modules/artplayer-plugin-hls-control/")) return "artplayer-hls-control";
          if (path.includes("/node_modules/artplayer/")) return "artplayer";
          return undefined;
        },
      },
    },
  },
  // Windows 上多个 vitest worker 并发写同一个 Vite SSR 缓存文件会 EPERM，
  // 导致第二个测试文件收集失败。纯函数用例 < 1s，串行收集即可。
  test: {
    fileParallelism: false,
    // `.workbuddy/` 是本地临时区（一次性探针脚本、参考实现克隆）。里面常出现
    // 别人的 `*.test.ts` 与自己的 tsconfig `extends`，vitest 默认会一路扫进去，
    // 表现为「我们的用例全绿，但 Test Files 有一堆 failed」。
    exclude: ["**/node_modules/**", "**/dist/**", "**/target/**", ".workbuddy/**"],
  },
});
