import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Tauri 需要固定端口；strictPort 避免端口漂移后 devUrl 对不上。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "chrome110",
    sourcemap: false,
  },
  // Windows 上多个 vitest worker 并发写同一个 Vite SSR 缓存文件会 EPERM，
  // 导致第二个测试文件收集失败。纯函数用例 < 1s，串行收集即可。
  test: {
    fileParallelism: false,
  },
});
