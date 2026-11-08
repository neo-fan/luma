import { defineConfig } from "vite";
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
});
