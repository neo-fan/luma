import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import packageJson from "./package.json";

// 版本号唯一来源：package.json。Cargo.toml / tauri.conf.json 手工保持同步，
// 前端通过 define 注入，避免侧栏 / 诊断页 / 日志里出现三个不同版本。
const APP_VERSION = packageJson.version;

// Tauri 需要固定端口；strictPort 避免端口漂移后 devUrl 对不上。
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
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
  },
});
